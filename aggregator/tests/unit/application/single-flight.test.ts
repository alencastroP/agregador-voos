import { describe, expect, it } from 'vitest';
import { SingleFlight } from '../../../src/application/single-flight.js';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

describe('SingleFlight', () => {
  it('runs the work once for concurrent callers of the same key', async () => {
    const sf = new SingleFlight<string>();
    const gate = deferred<string>();
    let runs = 0;
    const work = () => {
      runs += 1;
      return gate.promise;
    };

    const calls = [sf.run('k', work), sf.run('k', work), sf.run('k', work)];
    expect(sf.size).toBe(1);
    gate.resolve('result');
    const results = await Promise.all(calls);

    expect(runs).toBe(1);
    expect(results.map((r) => r.value)).toEqual(['result', 'result', 'result']);
    expect(results.map((r) => r.leader)).toEqual([true, false, false]);
    expect(sf.size).toBe(0);
  });

  it('does not coalesce different keys', async () => {
    const sf = new SingleFlight<string>();
    let runs = 0;
    const work = (v: string) => () => {
      runs += 1;
      return Promise.resolve(v);
    };
    const [a, b] = await Promise.all([sf.run('a', work('A')), sf.run('b', work('B'))]);
    expect([a.value, b.value, runs]).toEqual(['A', 'B', 2]);
  });

  it('shares failures with everyone waiting, then lets the next call retry', async () => {
    const sf = new SingleFlight<string>();
    const gate = deferred<string>();
    const first = sf.run('k', () => gate.promise);
    const second = sf.run('k', () => Promise.resolve('never runs'));
    gate.reject(new Error('providers down'));

    await expect(first).rejects.toThrow('providers down');
    await expect(second).rejects.toThrow('providers down');
    expect(sf.size).toBe(0);
    await expect(sf.run('k', () => Promise.resolve('ok'))).resolves.toEqual({
      value: 'ok',
      leader: true,
    });
  });
});
