import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig } from '../../../src/config/env.js';

const valid = {
  PROVIDER_A_URL: 'http://provider-a:3000/provider-a/search',
  PROVIDER_B_URL: 'http://provider-b:3000/provider-b/search',
  PROVIDER_C_URL: 'http://provider-c:3000/provider-c/search',
};

describe('loadConfig', () => {
  it('applies defaults (port 8000, 3s provider budget)', () => {
    const config = loadConfig(valid);
    expect(config.http).toEqual({ host: '0.0.0.0', port: 8000 });
    expect(config.providers.timeoutMs).toBe(3000);
    expect(config.providers.urls.b).toBe(valid.PROVIDER_B_URL);
  });

  it('coerces numeric env strings', () => {
    expect(loadConfig({ ...valid, PORT: '9001' }).http.port).toBe(9001);
  });

  it('fails fast listing EVERY missing/invalid variable at once', () => {
    try {
      loadConfig({ PROVIDER_A_URL: 'not-a-url', PORT: 'abc' });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const problems = (error as ConfigError).problems.join('\n');
      expect(problems).toMatch(/PROVIDER_A_URL/);
      expect(problems).toMatch(/PROVIDER_B_URL/);
      expect(problems).toMatch(/PROVIDER_C_URL/);
      expect(problems).toMatch(/PORT/);
    }
  });

  it('treats empty optional URLs as unset (compose passes ${VAR:-})', () => {
    const config = loadConfig({
      ...valid,
      REDIS_URL: '',
      DATABASE_URL: '',
      OTEL_EXPORTER_OTLP_ENDPOINT: '',
    });
    expect(config.cache.redisUrl).toBeUndefined();
    expect(config.database.url).toBeUndefined();
    expect(config.telemetry.otlpEndpoint).toBeUndefined();
  });

  it('still rejects a malformed optional URL', () => {
    expect(() => loadConfig({ ...valid, REDIS_URL: 'not a url' })).toThrow(ConfigError);
  });
});
