import { context } from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  TracerProvider,
} from '@opentelemetry/sdk-trace';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { silentLogger } from '../../../src/application/ports/logger.js';
import { ProviderUnavailableError } from '../../../src/domain/errors.js';
import { DEFAULT_INCENTIVE_BPS } from '../../../src/domain/provider.js';
import { activeTraceIds, OtelTracer } from '../../../src/infrastructure/observability/telemetry.js';
import { mapProviderA } from '../../../src/infrastructure/providers/mappers/provider-a.mapper.js';
import { FakeProvider, useCase } from '../../helpers/app.js';
import { loadProviderFixture, query } from '../../helpers/fixtures.js';

/** SDK real do OTel com exportador em memória: valida a ESTRUTURA do trace de uma busca. */
const exporter = new InMemorySpanExporter();
const contextManager = new AsyncLocalStorageContextManager();

// Provider LOCAL (nunca o global): o vitest 5 usa o @opentelemetry/api internamente, e
// registrar/desligar o provider global interfere no runner. Só o context manager é global
// (é ele que faz spans aninhados via AsyncLocalStorage).
const provider = new TracerProvider({ spanProcessors: [new SimpleSpanProcessor({ exporter })] });
const otel = () => new OtelTracer(provider.getTracer('test'));

beforeAll(() => {
  context.setGlobalContextManager(contextManager.enable());
});
afterAll(async () => {
  await provider.shutdown();
});
beforeEach(() => {
  exporter.reset();
});

const input = { origin: 'GRU', destination: 'GIG', date: '2026-12-12' };

describe('OtelTracer + use case', () => {
  it('emits one trace per search: search → provider spans + cache spans, with attributes', async () => {
    const providers = [
      new FakeProvider('provider-a', {
        kind: 'ok',
        result: () =>
          mapProviderA(loadProviderFixture('a'), query(), DEFAULT_INCENTIVE_BPS['provider-a']),
      }),
      new FakeProvider('provider-c', {
        kind: 'fail',
        error: new ProviderUnavailableError('provider-c', 'HTTP 500', true, 500),
      }),
    ];
    await useCase({ providers, tracer: otel() }).execute(input, { logger: silentLogger });

    const spans = exporter.getFinishedSpans();
    const byName = new Map(spans.map((s) => [s.name, s]));
    const root = byName.get('search');
    expect(root).toBeDefined();
    expect(root?.attributes).toMatchObject({
      'search.origin': 'GRU',
      'search.partial': true,
      'search.results': 40,
      'search.cached': false,
    });

    for (const child of ['provider provider-a', 'provider provider-c', 'cache.get', 'cache.set']) {
      const span = byName.get(child);
      expect(span, child).toBeDefined();
      expect(span?.spanContext().traceId).toBe(root?.spanContext().traceId); // mesmo trace
      expect(span?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId); // filho da busca
    }
    expect(byName.get('provider provider-a')?.attributes).toMatchObject({
      'provider.status': 'ok',
      'provider.offers': 40,
    });
    expect(byName.get('provider provider-c')?.status.code).toBe(2); // SpanStatusCode.ERROR
  });

  it('marks the span as error and rethrows when the work fails', async () => {
    const tracer = otel();
    await expect(
      tracer.withSpan('boom', {}, () => Promise.reject(new Error('kaput'))),
    ).rejects.toThrow('kaput');
    const [span] = exporter.getFinishedSpans();
    expect(span?.status).toMatchObject({ code: 2, message: 'kaput' });
    expect(span?.events.some((e) => e.name === 'exception')).toBe(true);
  });

  it('activeTraceIds exposes the current trace for log correlation', async () => {
    expect(activeTraceIds()).toEqual({}); // fora de span
    let inside: ReturnType<typeof activeTraceIds> = {};
    await otel().withSpan('outer', {}, () => {
      inside = activeTraceIds();
      return Promise.resolve();
    });
    const [span] = exporter.getFinishedSpans();
    expect(inside).toEqual({
      traceId: span?.spanContext().traceId,
      spanId: span?.spanContext().spanId,
    });
  });
});
