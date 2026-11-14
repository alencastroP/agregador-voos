# ADR 0002: Arquitetura hexagonal com DI manual, Fastify e Zod

- **Status:** aceito
- **Data:** 2026-11-14

## Contexto

O serviço é pequeno, mas tem três fontes externas com contratos diferentes, mais Redis,
Postgres, métricas e tracing. A regra de negócio (qual oferta exibir) é o coração da avaliação e
precisa ser testável sem rede, sem Redis e sem relógio real.

## Decisão

Ports & adapters em quatro camadas, com a direção de dependência **garantida por lint**
(`no-restricted-imports` em `eslint.config.js`), não só por convenção:

```
interfaces/http  ──►  application (use cases + ports)  ──►  domain (regras puras)
infrastructure   ──►  implementa os ports de application
main.ts          ──►  composition root: o único arquivo que conhece tudo
```

- **domain/**: Money em centavos, IataCode, chave de voo, estratégias de seleção, ordenação e
  erros tipados. Zero dependência de framework.
- **application/**: use case `SearchFlights` e ports (`FlightProvider`, `SearchCache`,
  `SearchRepository`, `FeatureFlags`, `Clock`).
- **infrastructure/**: adapters dos providers A/B/C, Redis, Postgres, OTel, métricas e flags.
- **interfaces/http/**: Fastify, schemas, e o **único** lugar que traduz erro em HTTP (Problem
  Details, RFC 9457).
- **Injeção de dependência manual** em `main.ts`: sem container nem decorators; o grafo se lê de
  cima a baixo.
- **Fastify**: leve, schema-first, `inject()` para testar HTTP sem abrir porta, pino embutido.
- **Zod**: um schema serve de validação em runtime e de tipo estático (`z.infer`), sem duplicar
  contrato.

## Alternativas consideradas

1. **NestJS.** Traz DI, módulos e interceptors prontos, mas esconde o grafo atrás de decorators e
   metadados de reflexão. Aqui o objetivo é mostrar a arquitetura feita à mão.
2. **Camadas "controller/service/repository" sem ports.** É mais simples, mas acopla o use case
   ao Redis/HTTP e obriga a mockar biblioteca em vez de interface.
3. **Express.** Mais conhecido, mas sem schema nativo, com logger acoplado por fora e tratamento
   de async mais fraco.

## Consequências

- (+) Estratégia de seleção, dedup e ordenação testáveis como funções puras.
- (+) Trocar Redis por outro cache, ou um provider por um real, é escrever um adapter.
- (−) Mais arquivos do que um serviço de 300 linhas "precisaria". Mitigação: sem abstração
  especulativa; só existem ports com mais de uma implementação real (produção + teste).
