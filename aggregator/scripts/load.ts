/**
 * npm run load [-- --n 200 --concurrency 10 --url http://localhost:8000]
 *
 * Carga contra o agregador RODANDO. Cada busca usa uma chave única (rota × data), para o
 * cache não esconder falhas. Feito para rodar com `make chaos` e medir na prática quanto o
 * retry recupera (conta teórica: 49% por tentativa → 1 − 0,51³ ≈ 87% com 3 tentativas).
 */
interface ProviderReport {
  name: string;
  status: string;
  latencyMs: number;
  attempts: number;
}
interface SearchBody {
  meta?: { partial: boolean; providers: ProviderReport[] };
}

const arg = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
};
const N = Number(arg('n', '200'));
const CONCURRENCY = Number(arg('concurrency', '10'));
const URL_ = arg('url', 'http://localhost:8000');

const AIRPORTS = [
  'GRU',
  'GIG',
  'CGH',
  'SDU',
  'BSB',
  'CNF',
  'SSA',
  'REC',
  'POA',
  'FOR',
  'CWB',
  'FLN',
];
const PAIRS = AIRPORTS.flatMap((o) => AIRPORTS.filter((d) => d !== o).map((d) => [o, d] as const));
const runId = Date.now() % 97; // desloca as datas a cada execução: chaves novas, sem cache

function nthQuery(i: number) {
  const [origin, destination] = PAIRS[i % PAIRS.length] ?? ['GRU', 'GIG'];
  const days = 1 + ((Math.floor(i / PAIRS.length) + runId) % 300);
  const date = new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
  return { origin, destination, date };
}

const pct = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))] ?? 0;
};

async function main(): Promise<void> {
  const httpStatus = new Map<number, number>();
  const totalLatency: number[] = [];
  let partial = 0;
  interface Stats {
    status: Map<string, number>;
    attempts: Map<number, number>;
    latency: number[];
  }
  const perProvider = new Map<string, Stats>();

  let next = 0;
  const worker = async () => {
    while (next < N) {
      const i = next++;
      const started = performance.now();
      const res = await fetch(`${URL_}/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(nthQuery(i)),
      });
      const body = (await res.json()) as SearchBody;
      totalLatency.push(performance.now() - started);
      httpStatus.set(res.status, (httpStatus.get(res.status) ?? 0) + 1);
      if (body.meta?.partial) partial += 1;
      for (const p of body.meta?.providers ?? []) {
        const s: Stats = perProvider.get(p.name) ?? {
          status: new Map(),
          attempts: new Map(),
          latency: [],
        };
        s.status.set(p.status, (s.status.get(p.status) ?? 0) + 1);
        s.attempts.set(p.attempts, (s.attempts.get(p.attempts) ?? 0) + 1);
        s.latency.push(p.latencyMs);
        perProvider.set(p.name, s);
      }
    }
  };
  const started = performance.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const seconds = (performance.now() - started) / 1000;

  console.log(`\n${N} buscas únicas, concorrência ${CONCURRENCY}, ${seconds.toFixed(1)} s`);
  console.log(`HTTP: ${JSON.stringify(Object.fromEntries(httpStatus))}  parciais: ${partial}`);
  console.log(
    `latência total p50/p95/p99: ${pct(totalLatency, 50).toFixed(0)} / ${pct(totalLatency, 95).toFixed(0)} / ${pct(totalLatency, 99).toFixed(0)} ms`,
  );
  console.table(
    [...perProvider.entries()].sort().map(([name, s]) => {
      const total = [...s.status.values()].reduce((a, b) => a + b, 0);
      const share = (k: string) => `${(((s.status.get(k) ?? 0) / total) * 100).toFixed(1)}%`;
      return {
        provider: name,
        ok: share('ok'),
        timeout: share('timeout'),
        error: share('error'),
        circuit_open: share('circuit_open'),
        tentativas: JSON.stringify(Object.fromEntries([...s.attempts.entries()].sort())),
        'p50 ms': pct(s.latency, 50),
        'p95 ms': pct(s.latency, 95),
        'p99 ms': pct(s.latency, 99),
      };
    }),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
