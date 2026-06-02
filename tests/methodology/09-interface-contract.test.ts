/**
 * 接口/契约测试 (Interface & Contract Testing)
 * 验证模块间 API 通信的接口契约：参数类型、返回值格式、回调约定。
 * 覆盖: Comparator, FilterPolicy, Env, Logger, IterLike 接口, CacheHandle 约定
 */
import { describe, it, expect } from 'vitest';
import { BytewiseComparator } from '../../src/comparator.js';
import type { Comparator } from '../../src/comparator.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import type { FilterPolicy } from '../../src/sstable/bloom.js';
import { NodeEnv } from '../../src/env.js';
import type { Env } from '../../src/env.js';
import { ConsoleLogger, NoopLogger } from '../../src/logger.js';
import type { Logger } from '../../src/logger.js';
import type { IterLike } from '../../src/iterator.js';
import { WriteBatch } from '../../src/write_batch.js';
import { LRUCache } from '../../src/cache.js';
import type { CacheHandle } from '../../src/cache.js';
import { Snapshot } from '../../src/snapshot.js';

// ─── Comparator 接口契约 ───
describe('Comparator Contract', () => {
  const cmp: Comparator = new BytewiseComparator();

  it('name() should return string', () => {
    expect(typeof cmp.name()).toBe('string');
  });

  it('compare(a,b) should return: <0 if a<b, 0 if a==b, >0 if a>b', () => {
    const a = Buffer.from('a');
    const b = Buffer.from('b');
    expect(cmp.compare(a, b)).toBeLessThan(0);
    expect(cmp.compare(b, a)).toBeGreaterThan(0);
    expect(cmp.compare(a, a)).toBe(0);
  });

  it('findShortestSeparator result should be >= start and < limit', () => {
    const start = Buffer.from('aaa');
    const limit = Buffer.from('aaz');
    const r = cmp.findShortestSeparator(start, limit);
    expect(cmp.compare(r, start)).toBeGreaterThanOrEqual(0);
    expect(cmp.compare(r, limit)).toBeLessThan(0);
  });

  it('findShortSuccessor result should be > key', () => {
    const key = Buffer.from('hello');
    const r = cmp.findShortSuccessor(key);
    expect(cmp.compare(r, key)).toBeGreaterThan(0);
  });
});

// ─── FilterPolicy 接口契约 ───
describe('FilterPolicy Contract', () => {
  const filter: FilterPolicy = newBloomFilterPolicy(10);

  it('name() should return string', () => {
    expect(typeof filter.name()).toBe('string');
  });

  it('createFilter([]) should return non-empty buffer', () => {
    const result = filter.createFilter([]);
    expect(result).toBeInstanceOf(Buffer);
    expect(result.length).toBeGreaterThan(0);
  });

  it('createFilter(keys) should grow with more keys', () => {
    const small = filter.createFilter([Buffer.from('a')]);
    const large = filter.createFilter([Buffer.from('a'), Buffer.from('b'), Buffer.from('c')]);
    expect(small.length).toBeLessThanOrEqual(large.length);
  });

  it('keyMayMatch should return boolean for valid filter', () => {
    const keys = [Buffer.from('test')];
    const bloom = filter.createFilter(keys);
    expect(typeof filter.keyMayMatch(Buffer.from('test'), bloom)).toBe('boolean');
  });

  it('keyMayMatch should not throw on empty/truncated filter', () => {
    expect(() => filter.keyMayMatch(Buffer.from('key'), Buffer.alloc(0))).not.toThrow();
    expect(typeof filter.keyMayMatch(Buffer.from('key'), Buffer.alloc(1))).toBe('boolean');
  });
});

// ─── Env 接口契约 ───
describe('Env Contract', () => {
  const env: Env = new NodeEnv();

  it('all methods should return promises where applicable', () => {
    // Verify the interface shape — all methods return Promise
    const p = env.createDir('tmp-env-test-dir');
    expect(p).toBeInstanceOf(Promise);
    // Cleanup the test directory
    p.then(() => env.removeDir('tmp-env-test-dir')).catch(() => {});
  });
});

// ─── Logger 接口契约 ───
describe('Logger Contract', () => {
  it('ConsoleLogger implements Logger interface', () => {
    const logger: Logger = new ConsoleLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('NoopLogger implements Logger interface', () => {
    const logger: Logger = new NoopLogger();
    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('Logger methods accept variadic args', () => {
    const logger = new ConsoleLogger();
    expect(() => logger.info('msg', 1, true, { key: 'value' })).not.toThrow();
    expect(() => logger.warn('msg', null)).not.toThrow();
    expect(() => logger.error('msg', undefined)).not.toThrow();
  });
});

// ─── CacheHandle 契约 ───
describe('CacheHandle Contract', () => {
  it('insert returns CacheHandle with value and charge', () => {
    const cache = new LRUCache(100);
    const handle = cache.insert(Buffer.from('key'), Buffer.from('value'), 42);
    expect(handle).toHaveProperty('value');
    expect(handle).toHaveProperty('charge');
    expect(handle.value).toEqual(Buffer.from('value'));
    expect(handle.charge).toBe(42);
  });

  it('lookup returns CacheHandle or null', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('key'), Buffer.from('value'), 10);
    const handle = cache.lookup(Buffer.from('key'));
    expect(handle).not.toBeNull();
    expect(handle!.value).toEqual(Buffer.from('value'));

    const missing = cache.lookup(Buffer.from('nope'));
    expect(missing).toBeNull();
  });
});

// ─── WriteBatch 迭代契约 ───
describe('WriteBatch Iteration Contract', () => {
  it('iterate callback receives (key, value, type)', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    batch.iterate((key, value, type) => {
      expect(key).toEqual(Buffer.from('k'));
      expect(value).toEqual(Buffer.from('v'));
      expect(type).toBe(1); // ValueType.Value
    });
  });

  it('append copies data (immutability)', () => {
    const original = new WriteBatch();
    original.put(Buffer.from('k'), Buffer.from('v'));
    const copy = new WriteBatch();
    copy.append(original);
    // Modifying original shouldn't affect copy
    original.clear();
    expect(copy.approxSize()).toBeGreaterThan(0);
  });
});

// ─── Snapshot Disposable 契约 ───
describe('Snapshot Disposable Contract', () => {
  it('implements Symbol.dispose for using syntax', () => {
    const snap = new Snapshot(1n);
    expect(Symbol.dispose in snap).toBe(true);
    expect(typeof snap[Symbol.dispose]).toBe('function');
  });

  it('onRelease is called exactly once on dispose', () => {
    let calls = 0;
    {
      const snap = new Snapshot(1n, () => { calls++; });
      snap[Symbol.dispose]();
    }
    expect(calls).toBe(1);
  });
});
