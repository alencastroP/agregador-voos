export type SpanAttributes = Record<string, string | number | boolean>;

export interface SpanHandle {
  setAttributes(attributes: SpanAttributes): void;
  /** Marca o span como erro (sem lançar: quem decide o fluxo é o chamador). */
  recordError(error: unknown): void;
}

/**
 * Port de tracing. O use case abre spans (busca, provider, cache) sem depender do SDK do
 * OpenTelemetry; a implementação OTel propaga contexto (o fetch do provider vira span filho).
 */
export interface Tracer {
  withSpan<T>(
    name: string,
    attributes: SpanAttributes,
    fn: (span: SpanHandle) => Promise<T>,
  ): Promise<T>;
}

const noopSpan: SpanHandle = { setAttributes: () => undefined, recordError: () => undefined };

export const noopTracer: Tracer = {
  withSpan: (_name, _attributes, fn) => fn(noopSpan),
};
