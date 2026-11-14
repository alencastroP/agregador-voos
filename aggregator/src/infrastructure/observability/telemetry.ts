import {
  context,
  propagation,
  SpanStatusCode,
  trace,
  type Span,
  type Tracer as OtelApiTracer,
} from '@opentelemetry/api';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import { W3CTraceContextPropagator } from '@opentelemetry/core';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { BatchSpanProcessor, TracerProvider } from '@opentelemetry/sdk-trace';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { SpanAttributes, SpanHandle, Tracer } from '../../application/ports/tracer.js';

export interface TelemetryOptions {
  /** Base OTLP/HTTP (ex.: http://jaeger:4318). Sem endpoint, o tracing fica desligado (no-op). */
  readonly endpoint: string | undefined;
  readonly serviceName: string;
  readonly serviceVersion: string;
}

export interface Telemetry {
  shutdown(): Promise<void>;
}

/**
 * Liga o tracing com a montagem MÍNIMA (o que o NodeSDK faria por dentro, sem trazer
 * exportadores de métricas/logs/gRPC que não usamos: −30 MB de dependências na imagem):
 *   provider + BatchSpanProcessor → OTLP/HTTP (Jaeger na 4318),
 *   context manager (AsyncLocalStorage) para spans aninhados,
 *   propagador W3C (traceparent nas chamadas aos providers),
 *   instrumentação do undici (fetch) via diagnostics_channel.
 * Spans de negócio (busca, provider, cache) são MANUAIS via port Tracer. Sem auto-instrumentação
 * de http/fastify: em ESM ela exige loader hooks (import-in-the-middle) frágeis.
 */
export function startTelemetry(options: TelemetryOptions): Telemetry | null {
  if (!options.endpoint) return null;

  const provider = new TracerProvider({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]: options.serviceName,
      [ATTR_SERVICE_VERSION]: options.serviceVersion,
    }),
    spanProcessors: [
      new BatchSpanProcessor({
        exporter: new OTLPTraceExporter({
          url: `${options.endpoint.replace(/\/$/, '')}/v1/traces`,
        }),
      }),
    ],
  });
  context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
  propagation.setGlobalPropagator(new W3CTraceContextPropagator());
  trace.setGlobalTracerProvider(provider);
  const unregister = registerInstrumentations({
    tracerProvider: provider,
    instrumentations: [new UndiciInstrumentation()],
  });

  return {
    shutdown: async () => {
      unregister();
      await provider.shutdown(); // flush dos spans pendentes
    },
  };
}

function handle(span: Span): SpanHandle {
  return {
    setAttributes: (attributes: SpanAttributes) => {
      span.setAttributes(attributes);
    },
    recordError: (error: unknown) => {
      if (error instanceof Error) span.recordException(error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : String(error),
      });
    },
  };
}

/**
 * Implementação OTel do port Tracer. `startActiveSpan` coloca o span no contexto
 * (AsyncLocalStorage): spans abertos dentro de `fn`, inclusive o do fetch, viram filhos.
 * Sem SDK iniciado, a API do OTel devolve um tracer no-op: custo praticamente zero.
 */
export class OtelTracer implements Tracer {
  /** Injetável para teste (provider local); em produção usa o provider global do SDK. */
  constructor(private readonly tracer: OtelApiTracer = trace.getTracer('flight-aggregator')) {}

  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T> {
    return this.tracer.startActiveSpan(name, { attributes }, async (span) => {
      try {
        return await fn(handle(span));
      } catch (error) {
        handle(span).recordError(error);
        throw error;
      } finally {
        span.end();
      }
    });
  }
}

/** Para o mixin do pino: todo log dentro de um span sai com trace_id/span_id (log ↔ trace). */
export function activeTraceIds(): { traceId?: string; spanId?: string } {
  const ctx = trace.getActiveSpan()?.spanContext();
  return ctx && trace.isSpanContextValid(ctx) ? { traceId: ctx.traceId, spanId: ctx.spanId } : {};
}
