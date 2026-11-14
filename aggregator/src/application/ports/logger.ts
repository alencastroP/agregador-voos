/**
 * Logger estruturado mínimo (compatível com pino). O use case recebe o logger DA REQUISIÇÃO,
 * que já carrega o requestId: todo log da busca sai correlacionado sem passar id à mão.
 */
export interface Logger {
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
}

export const silentLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};
