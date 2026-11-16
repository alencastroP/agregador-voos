import { beforeAll, describe, expect, it } from 'vitest';

/**
 * E2E contra a STACK REAL (docker compose: mocks + Redis + Postgres + agregador).
 * Pré-requisito: `make up`. Rodar: `make e2e` (ou E2E_BASE_URL=http://host:8000 npm run test:e2e).
 * Cenários que os mocks NÃO produzem (todos falhando, payload fora do contrato) ficam nos testes
 * de integração, com providers simulados.
 */
const BASE = process.env.E2E_BASE_URL ?? 'http://localhost:8000';

interface Result {
  flightKey: string;
  airline: { code: string; displayName: string };
  departureAt: string;
  arrivalAt: string;
  durationMinutes: number;
  price: { amountCents: number; currency: string };
  provider: string;
  selection: { deltaToCheapestCents: number; strategy: string };
}
interface SearchBody {
  searchId: string;
  results: Result[];
  meta: {
    cached: boolean;
    partial: boolean;
    strategy: string;
    providers: { name: string; status: string; offersCount: number; discardedCount: number }[];
  };
}

// Data e rota "novas" a cada execução: a 1ª chamada nunca vem de cache de uma execução anterior.
const offset = 20 + (Date.now() % 250);
const date = new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const body = { origin: 'GRU', destination: 'GIG', date };

async function search(payload: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(`${BASE}/search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(payload),
  });
  return { res, json: (await res.json()) as SearchBody & Record<string, unknown> };
}

let first: SearchBody;
let firstRes: Response;

beforeAll(async () => {
  for (let i = 0; i < 30; i++) {
    const ready = await fetch(`${BASE}/health/ready`).catch(() => undefined);
    if (ready?.ok) break;
    await new Promise((r) => setTimeout(r, 1_000));
  }
  const r = await search(body, { 'x-request-id': `e2e-${offset}` });
  firstRes = r.res;
  first = r.json;
}, 60_000);

describe('POST /search against the real mocks', () => {
  it('answers 200 with all three providers ok and the correlation id echoed', () => {
    expect(firstRes.status).toBe(200);
    expect(firstRes.headers.get('x-request-id')).toBe(`e2e-${offset}`);
    expect(first.meta.partial).toBe(false);
    expect(first.meta.providers.map((p) => `${p.name}:${p.status}`)).toEqual([
      'provider-a:ok',
      'provider-b:ok',
      'provider-c:ok',
    ]);
  });

  it('returns 60 unique flights after deduplicating 120 offers', () => {
    expect(first.meta.providers.reduce((s, p) => s + p.offersCount, 0)).toBe(120);
    expect(first.results).toHaveLength(60);
    expect(new Set(first.results.map((r) => r.flightKey)).size).toBe(60);
  });

  it('drops the dirty records (USD fare and zero fare) and never returns a float price', () => {
    expect(first.meta.providers.map((p) => p.discardedCount)).toEqual([0, 1, 1]);
    for (const r of first.results) {
      expect(r.price.currency).toBe('BRL');
      expect(Number.isSafeInteger(r.price.amountCents)).toBe(true);
      expect(r.price.amountCents).toBeGreaterThan(0);
    }
    expect(first.results.some((r) => /copa/i.test(r.airline.displayName))).toBe(false);
  });

  it('normalizes every spelling (incl. "Passaredo") into the 4 canonical airlines', () => {
    expect(new Set(first.results.map((r) => r.airline.code))).toEqual(
      new Set(['LATAM', 'GOL', 'AZUL', 'VOEPASS']),
    );
  });

  it('puts the 4 overnight flights on D+1', () => {
    const overnight = first.results.filter(
      (r) => r.arrivalAt.slice(0, 10) > r.departureAt.slice(0, 10),
    );
    expect(overnight).toHaveLength(4);
    expect(overnight.every((r) => r.durationMinutes > 0)).toBe(true);
  });

  it('applies the balanced strategy (A→C only on A+C flights) and sorts by price', () => {
    expect(first.meta.strategy).toBe('balanced');
    expect(first.results.filter((r) => r.selection.deltaToCheapestCents > 0)).toHaveLength(10);
    const prices = first.results.map((r) => r.price.amountCents);
    expect(prices).toEqual([...prices].sort((a, b) => a - b));
  });

  it('second identical call is a cache hit with the SAME order', async () => {
    const { json } = await search({ ...body, origin: 'gru' }); // IATA normalizado → mesma chave
    expect(json.meta.cached).toBe(true);
    expect(json.searchId).not.toBe(first.searchId);
    expect(json.results.map((r) => r.flightKey)).toEqual(first.results.map((r) => r.flightKey));
  });

  it('rejects invalid input with 400 problem+json listing every field', async () => {
    const { res, json } = await search({ origin: 'XX', destination: 'GIG', date: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(res.headers.get('content-type')).toMatch(/application\/problem\+json/);
    expect((json.errors as { field: string }[]).map((e) => e.field)).toEqual(['origin', 'date']);
  });
});

describe('operational endpoints', () => {
  it('/health reports cache, database and circuits', async () => {
    const health = (await (await fetch(`${BASE}/health`)).json()) as {
      status: string;
      checks: Record<string, { status: string }>;
    };
    expect(health.status).toBe('ok');
    expect(health.checks.cache?.status).toBe('up');
    expect(health.checks.database?.status).toBe('up');
    expect(health.checks.providers?.status).toBe('up');
  });

  it('/metrics exposes business and provider metrics', async () => {
    const text = await (await fetch(`${BASE}/metrics`)).text();
    expect(text).toMatch(/search_requests_total\{outcome="ok",cached="false"\}/);
    expect(text).toMatch(/selection_incentive_gain_cents_total\{strategy="balanced"\}/);
    expect(text).toMatch(/provider_request_duration_seconds_bucket\{.*provider="provider-c"/);
  });
});
