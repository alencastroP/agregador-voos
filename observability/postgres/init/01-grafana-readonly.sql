-- Roda só na PRIMEIRA inicialização do volume do Postgres.
-- O Grafana lê com um papel SOMENTE LEITURA: o dashboard nunca consegue escrever ou apagar.
-- As tabelas são criadas depois, pelas migrations do agregador (usuário "aggregator"),
-- então o SELECT é concedido por DEFAULT PRIVILEGES para as tabelas futuras.
CREATE ROLE grafana_ro WITH LOGIN PASSWORD 'grafana_ro';
GRANT CONNECT ON DATABASE aggregator TO grafana_ro;
GRANT USAGE ON SCHEMA public TO grafana_ro;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO grafana_ro;
ALTER DEFAULT PRIVILEGES FOR ROLE aggregator IN SCHEMA public GRANT SELECT ON TABLES TO grafana_ro;
