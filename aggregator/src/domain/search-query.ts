import type { IataCode } from './iata-code.js';
import type { IsoDate } from './local-date-time.js';

/** Busca já validada (a validação acontece na borda, no use case/HTTP). */
export interface SearchQuery {
  readonly origin: IataCode;
  readonly destination: IataCode;
  readonly date: IsoDate;
}
