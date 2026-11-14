/**
 * npm run simulate [-- --fixtures]
 *
 * Roda as estratégias de seleção sobre buscas REAIS dos mocks e imprime o trade-off
 * empresa × cliente. Sem `--fixtures`, consulta os providers (URLs via env, default localhost).
 * Com `--fixtures`, usa as respostas gravadas em tests/fixtures (offline/reprodutível).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderSearchResult } from '../src/application/ports/flight-provider.js';
import { parseIataCode, type IataCode } from '../src/domain/iata-code.js';
import { parseIsoDate, type IsoDate } from '../src/domain/local-date-time.js';
import { formatBRL } from '../src/domain/money.js';
import { DEFAULT_INCENTIVE_BPS, type ProviderId } from '../src/domain/provider.js';
import type { SearchQuery } from '../src/domain/search-query.js';
import { selectOffers } from '../src/domain/selection/select-offers.js';
import {
  BalancedStrategy,
  CheapestStrategy,
  DEFAULT_BALANCED_PARAMS,
  MaxIncentiveStrategy,
  type BalancedParams,
} from '../src/domain/selection/strategies.js';
import type { OfferSelectionStrategy } from '../src/domain/selection/strategy.js';
import type { ProviderMapper } from '../src/infrastructure/providers/mappers/map-items.js';
import { mapProviderA } from '../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { mapProviderB } from '../src/infrastructure/providers/mappers/provider-b.mapper.js';
import { mapProviderC } from '../src/infrastructure/providers/mappers/provider-c.mapper.js';

const PROVIDERS: readonly { id: ProviderId; url: string; map: ProviderMapper; fixture: string }[] =
  [
    {
      id: 'provider-a',
      url: process.env.PROVIDER_A_URL ?? 'http://localhost:3001/provider-a/search',
      map: mapProviderA,
      fixture: 'a',
    },
    {
      id: 'provider-b',
      url: process.env.PROVIDER_B_URL ?? 'http://localhost:3002/provider-b/search',
      map: mapProviderB,
      fixture: 'b',
    },
    {
      id: 'provider-c',
      url: process.env.PROVIDER_C_URL ?? 'http://localhost:3003/provider-c/search',
      map: mapProviderC,
      fixture: 'c',
    },
  ];

const useFixtures = process.argv.includes('--fixtures');

function must<T>(value: T | null, label: string): T {
  if (value === null) throw new Error(`invalid ${label}`);
  return value;
}

function q(origin: string, destination: string, date: string): SearchQuery {
  return {
    origin: must<IataCode>(parseIataCode(origin), 'origin'),
    destination: must<IataCode>(parseIataCode(destination), 'destination'),
    date: must<IsoDate>(parseIsoDate(date), 'date'),
  };
}

function plusDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);
}

async function fetchProvider(
  p: (typeof PROVIDERS)[number],
  query: SearchQuery,
): Promise<ProviderSearchResult> {
  let payload: unknown;
  if (useFixtures) {
    const file = join(
      import.meta.dirname,
      '..',
      'tests',
      'fixtures',
      `provider-${p.fixture}.2026-12-12.GRU-GIG.json`,
    );
    payload = JSON.parse(readFileSync(file, 'utf-8'));
  } else {
    const res = await fetch(p.url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(query),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) throw new Error(`${p.id} HTTP ${res.status}`);
    payload = await res.json();
  }
  return p.map(payload, query, DEFAULT_INCENTIVE_BPS[p.id]);
}

interface Totals {
  searches: number;
  flights: number;
  incentive: number;
  customerExtra: number;
  differs: number;
}

const empty = (): Totals => ({
  searches: 0,
  flights: 0,
  incentive: 0,
  customerExtra: 0,
  differs: 0,
});

function accumulate(t: Totals, strategy: OfferSelectionStrategy, offers: ProviderSearchResult[]) {
  const selected = selectOffers(
    offers.flatMap((r) => r.offers),
    strategy,
  );
  t.searches += 1;
  t.flights += selected.length;
  for (const { offer, selection } of selected) {
    t.incentive += offer.incentiveAmountCents;
    t.customerExtra += selection.deltaToCheapestCents;
    if (selection.deltaToCheapestCents > 0) t.differs += 1;
  }
}

function pct(n: number, d: number): string {
  return d === 0 ? '—' : `${((n / d) * 100).toFixed(1)}%`;
}

/** Linha 0 é sempre o baseline `cheapest` (ver run()). */
function report(title: string, rows: [string, Totals][]): void {
  const base = rows[0]?.[1];
  if (!base) return;
  console.log(`\n${title}`);
  console.table(
    rows.map(([name, t], i) => {
      const gain = t.incentive - base.incentive;
      const prev = rows[i - 1]?.[1];
      const marginalGain = prev ? t.incentive - prev.incentive : 0;
      const marginalCost = prev ? t.customerExtra - prev.customerExtra : 0;
      return {
        estratégia: name,
        'incentivo total': formatBRL(t.incentive),
        'Δ incentivo vs cheapest': `${formatBRL(gain)} (${pct(gain, base.incentive)})`,
        'custo extra cliente': formatBRL(t.customerExtra),
        'R$ cliente / R$1 ganho (médio)': gain > 0 ? (t.customerExtra / gain).toFixed(2) : '—',
        'R$ cliente / R$1 ganho (marginal)':
          marginalGain > 0 ? (marginalCost / marginalGain).toFixed(2) : '—',
        'voos ≠ mais barato': `${t.differs}/${t.flights} (${pct(t.differs, t.flights)})`,
      };
    }),
  );
}

function strategiesUnderTest(): [string, OfferSelectionStrategy][] {
  const balanced = (p: Partial<BalancedParams>) =>
    new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, ...p });
  // Ordem crescente de agressividade: a coluna "marginal" compara cada linha com a anterior.
  return [
    ['cheapest', new CheapestStrategy()],
    ['balanced τ=1,5% teto R$25 k=1', balanced({ minGainRatio: 1 })],
    ['balanced τ=1,5% teto R$25', balanced({})],
    ['max_incentive', new MaxIncentiveStrategy()],
  ];
}

function tauSweep(): [string, OfferSelectionStrategy][] {
  return [0, 50, 100, 119, 120, 150, 200, 274, 275, 300].map((bps) => [
    `balanced τ=${(bps / 100).toFixed(2)}% teto R$25`,
    new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, tolerancePctBps: bps }),
  ]);
}

function kSweep(): [string, OfferSelectionStrategy][] {
  return [0, 0.5, 0.8, 0.85, 0.9, 1].map((k) => [
    `balanced τ=1,5% teto R$25 k=${k}`,
    new BalancedStrategy({ ...DEFAULT_BALANCED_PARAMS, minGainRatio: k }),
  ]);
}

async function run(
  queries: SearchQuery[],
  set: [string, OfferSelectionStrategy][],
  title: string,
): Promise<void> {
  const withBaseline: [string, OfferSelectionStrategy][] =
    set[0]?.[1] instanceof CheapestStrategy ? set : [['cheapest', new CheapestStrategy()], ...set];
  const totals = new Map(withBaseline.map(([name]) => [name, empty()]));
  for (const query of queries) {
    const results = await Promise.all(PROVIDERS.map((p) => fetchProvider(p, query)));
    for (const [name, strategy] of withBaseline) {
      accumulate(totals.get(name) ?? empty(), strategy, results);
    }
  }
  report(title, [...totals.entries()]);
}

async function main(): Promise<void> {
  const headline = [q('GRU', 'GIG', '2026-12-12')];
  await run(headline, strategiesUnderTest(), 'GRU→GIG 2026-12-12 (60 voos)');

  if (useFixtures) return;

  const routes = [
    ['GRU', 'GIG'],
    ['CGH', 'SDU'],
    ['BSB', 'GRU'],
    ['POA', 'REC'],
    ['CNF', 'SSA'],
  ] as const;
  const dates = [plusDays(7), plusDays(30), plusDays(60)];
  const wide = routes.flatMap(([o, d]) => dates.map((date) => q(o, d, date)));
  await run(wide, strategiesUnderTest(), `${wide.length} buscas (5 rotas × 3 datas)`);
  await run(wide, tauSweep(), 'Varredura de τ (teto R$25, k=0)');
  await run(wide, kSweep(), 'Varredura de k (τ=1,5%, teto R$25)');
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
