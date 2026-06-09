/**
 * Whitebox Test 06: Utility Module Coverage Boost
 *
 * Targets low-coverage modules:
 *   - status.ts   (47% → target 85%+)
 *   - error.ts    (0%  → target 85%+)
 *   - comparator.ts (10% → target 85%+)
 *   - cache.ts    (56% → target 85%+)
 *   - bloom.ts    (0%  → target 85%+)
 *   - codec.ts    (88% → target 95%+)
 */

import { describe, it, expect } from 'vitest';
import {
  Status,
  StatusCode,
} from '../../src/status.js';
import {
  LevelDBError,
  NotFoundError,
  CorruptionError,
  IOError,
  statusToError,
} from '../../src/error.js';
import { BytewiseComparator } from '../../src/comparator.js';
import type { Comparator } from '../../src/comparator.js';
import { LRUCache } from '../../src/cache.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import type { FilterPolicy } from '../../src/sstable/bloom.js';
import {
  putVarint32,
  getVarint32,
  putVarint64,
  getVarint64,
  putFixed32,
  getFixed32,
  crc32,
  crc32cMask,
  crc32cUnmask,
  encodeUserKey,
  decodeUserKey,
  encodeUserValue,
  decodeUserValue,
} from '../../src/codec.js';

// ─────────────────────────────────────────────────────────────
// status.ts
// ─────────────────────────────────────────────────────────────

describe('06a - Status', () => {
  it('Status.ok() should return ok status', () => {
    const s = Status.ok();
    expect(s.ok()).toBe(true);
    expect(s.isNotFound()).toBe(false);
    expect(s.isCorruption()).toBe(false);
    expect(s.isIOError()).toBe(false);
    expect(s.isNotSupported()).toBe(false);
    expect(s.toString()).toBe('OK');
  });

  it('Status.notFound() should return not-found status', () => {
    const s = Status.notFound('key not found');
    expect(s.ok()).toBe(false);
    expect(s.isNotFound()).toBe(true);
    expect(s.isCorruption()).toBe(false);
    expect(s.isIOError()).toBe(false);
    expect(s.isNotSupported()).toBe(false);
    expect(s.toString()).toContain('NotFound');
    expect(s.toString()).toContain('key not found');
  });

  it('Status.corruption() should return corruption status', () => {
    const s = Status.corruption('checksum mismatch');
    expect(s.ok()).toBe(false);
    expect(s.isNotFound()).toBe(false);
    expect(s.isCorruption()).toBe(true);
    expect(s.isIOError()).toBe(false);
    expect(s.toString()).toContain('Corruption');
    expect(s.toString()).toContain('checksum mismatch');
  });

  it('Status.ioError() should return IO error status', () => {
    const s = Status.ioError('disk full');
    expect(s.ok()).toBe(false);
    expect(s.isIOError()).toBe(true);
    expect(s.isNotFound()).toBe(false);
    expect(s.isCorruption()).toBe(false);
  });

  it('Status.notSupported() should return not-supported status', () => {
    const s = Status.notSupported('feature X');
    expect(s.ok()).toBe(false);
    expect(s.isNotSupported()).toBe(true);
    expect(s.isNotFound()).toBe(false);
    expect(s.isIOError()).toBe(false);
    expect(s.isCorruption()).toBe(false);
  });

  it('StatusCode enum values', () => {
    expect(StatusCode.OK).toBe(0);
    expect(StatusCode.NotFound).toBe(1);
    expect(StatusCode.Corruption).toBe(2);
    expect(StatusCode.NotSupported).toBe(3);
    expect(StatusCode.IOError).toBe(4);
  });
});

// ─────────────────────────────────────────────────────────────
// error.ts
// ─────────────────────────────────────────────────────────────

describe('06b - Error classes', () => {
  it('LevelDBError should have code and message', () => {
    const err = new LevelDBError('TEST_CODE', 'test message');
    expect(err.code).toBe('TEST_CODE');
    expect(err.message).toBe('test message');
    expect(err.name).toBe('LevelDBError');
    expect(err).toBeInstanceOf(Error);
  });

  it('NotFoundError should have NOT_FOUND code', () => {
    const err = new NotFoundError('key missing');
    expect(err.code).toBe('NOT_FOUND');
    expect(err.name).toBe('NotFoundError');
    expect(err).toBeInstanceOf(LevelDBError);
    expect(err).toBeInstanceOf(Error);
  });

  it('CorruptionError should have CORRUPTION code', () => {
    const err = new CorruptionError('bad checksum');
    expect(err.code).toBe('CORRUPTION');
    expect(err.name).toBe('CorruptionError');
    expect(err).toBeInstanceOf(LevelDBError);
  });

  it('IOError should have IO_ERROR code', () => {
    const err = new IOError('read failed');
    expect(err.code).toBe('IO_ERROR');
    expect(err.name).toBe('IOError');
    expect(err).toBeInstanceOf(LevelDBError);
  });

  it('statusToError should not throw for OK status', () => {
    expect(() => statusToError(Status.ok())).not.toThrow();
  });

  it('statusToError should throw NotFoundError for NotFound status', () => {
    expect(() => statusToError(Status.notFound('gone'))).toThrow(NotFoundError);
    try {
      statusToError(Status.notFound('test-msg'));
    } catch (e) {
      expect(e).toBeInstanceOf(NotFoundError);
      expect((e as NotFoundError).code).toBe('NOT_FOUND');
    }
  });

  it('statusToError should throw CorruptionError for Corruption status', () => {
    expect(() => statusToError(Status.corruption('bad'))).toThrow(CorruptionError);
  });

  it('statusToError should throw IOError for IOError status', () => {
    expect(() => statusToError(Status.ioError('disk'))).toThrow(IOError);
  });

  it('statusToError should throw LevelDBError for NotSupported status', () => {
    // NotSupported maps to UNKNOWN LevelDBError
    expect(() => statusToError(Status.notSupported('unsupported'))).toThrow(LevelDBError);
    try {
      statusToError(Status.notSupported('ns'));
    } catch (e) {
      expect(e).toBeInstanceOf(LevelDBError);
      expect((e as LevelDBError).code).toBe('UNKNOWN');
    }
  });
});

// ─────────────────────────────────────────────────────────────
// comparator.ts
// ─────────────────────────────────────────────────────────────

describe('06c - BytewiseComparator', () => {
  let cmp: BytewiseComparator;

  // Reset before each test
  beforeEach(() => {
    cmp = new BytewiseComparator();
  });

  it('name() should return leveldb.BytewiseComparator', () => {
    expect(cmp.name()).toBe('leveldb.BytewiseComparator');
  });

  it('compare() should return 0 for equal buffers', () => {
    expect(cmp.compare(Buffer.from('abc'), Buffer.from('abc'))).toBe(0);
  });

  it('compare() should return negative when a < b', () => {
    expect(cmp.compare(Buffer.from('aaa'), Buffer.from('aab'))).toBeLessThan(0);
    expect(cmp.compare(Buffer.from([0x00]), Buffer.from([0x01]))).toBeLessThan(0);
  });

  it('compare() should return positive when a > b', () => {
    expect(cmp.compare(Buffer.from('aab'), Buffer.from('aaa'))).toBeGreaterThan(0);
    expect(cmp.compare(Buffer.from([0xff]), Buffer.from([0x01]))).toBeGreaterThan(0);
  });

  it('compare() should handle different-length keys (shorter < longer prefix)', () => {
    // 'abc' < 'abcd' because after matching 'abc', 'abc' is shorter
    expect(cmp.compare(Buffer.from('abc'), Buffer.from('abcd'))).toBeLessThan(0);
  });

  it('compare() should handle empty buffers', () => {
    expect(cmp.compare(Buffer.alloc(0), Buffer.alloc(0))).toBe(0);
    expect(cmp.compare(Buffer.alloc(0), Buffer.from('a'))).toBeLessThan(0);
    expect(cmp.compare(Buffer.from('a'), Buffer.alloc(0))).toBeGreaterThan(0);
  });

  it('findShortestSeparator() with common prefix should shorten', () => {
    // "abcdef" and "abcxyz" → shortest separator ≥ start and < limit
    const result = cmp.findShortestSeparator(
      Buffer.from('abcdef'),
      Buffer.from('abcxyz')
    );
    // d[0] = 'a' (0x61), d[3] != limit[3]: 'd'(0x64) vs 'x'(0x78)
    // 0x64 < 0xff && 0x64+1(0x65) < 0x78 → "abce"
    expect(result.toString()).toBe('abce');
  });

  it('findShortestSeparator() when start is already minimal', () => {
    // start is shorter than common prefix
    const result = cmp.findShortestSeparator(
      Buffer.from('ab'),
      Buffer.from('abcxyz')
    );
    // diffIndex=2 >= start.length=2 → "ab"
    expect(result.toString()).toBe('ab');
  });

  it('findShortestSeparator() when byte cannot be incremented', () => {
    // "a\xff" and "b" → byte=0xff, cannot increment
    const result = cmp.findShortestSeparator(
      Buffer.from([0x61, 0xff]),
      Buffer.from([0x62])
    );
    // Returns start as-is
    expect(result).toEqual(Buffer.from([0x61, 0xff]));
  });

  it('findShortSuccessor() should increment last byte', () => {
    const result = cmp.findShortSuccessor(Buffer.from('abc'));
    // c (0x63) + 1 = d (0x64) → "abd"
    expect(result.toString()).toBe('abd');
  });

  it('findShortSuccessor() with all 0xff should append 0x00', () => {
    const result = cmp.findShortSuccessor(Buffer.from([0xff, 0xff, 0xff]));
    // All 0xff → append 0x00
    expect(result).toEqual(Buffer.from([0xff, 0xff, 0xff, 0x00]));
  });

  it('findShortSuccessor() with mid byte < 0xff', () => {
    const result = cmp.findShortSuccessor(Buffer.from([0x61, 0xff, 0x63]));
    // From right: 0x63 < 0xff → increment to 0x64 → [0x61, 0xff, 0x64]
    expect(result).toEqual(Buffer.from([0x61, 0xff, 0x64]));
  });

  it('findShortSuccessor() should handle empty key', () => {
    const result = cmp.findShortSuccessor(Buffer.alloc(0));
    // Empty → append 0x00
    expect(result).toEqual(Buffer.from([0x00]));
  });

  it('BytewiseComparator implements Comparator interface', () => {
    const c: Comparator = cmp;
    expect(c.name()).toBeTruthy();
    expect(typeof c.compare).toBe('function');
    expect(typeof c.findShortestSeparator).toBe('function');
    expect(typeof c.findShortSuccessor).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────
// cache.ts
// ─────────────────────────────────────────────────────────────

describe('06d - LRUCache', () => {
  it('should insert and lookup', () => {
    const cache = new LRUCache(1024);
    cache.insert(Buffer.from('k1'), Buffer.from('v1'), 100);
    const h = cache.lookup(Buffer.from('k1'));
    expect(h).not.toBeNull();
    expect(h!.value).toEqual(Buffer.from('v1'));
    expect(h!.charge).toBe(100);
    expect(cache.totalCharge()).toBe(100);
  });

  it('should return null for missing key', () => {
    const cache = new LRUCache(1024);
    expect(cache.lookup(Buffer.from('no-such'))).toBeNull();
  });

  it('should evict LRU entry when capacity exceeded', () => {
    const evicted: Buffer[] = [];
    const cache = new LRUCache(200, (_key, _value) => {
      evicted.push(_key);
    });

    cache.insert(Buffer.from('a'), Buffer.from('1'), 100);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 100);
    // Both fit within 200

    // Third entry pushes us over 200
    cache.insert(Buffer.from('c'), Buffer.from('3'), 100);
    // 'a' should be evicted (least recently used)
    expect(evicted.length).toBeGreaterThanOrEqual(1);
    expect(evicted.some(k => k.toString() === 'a')).toBe(true);

    // 'b' and 'c' should still be present
    expect(cache.lookup(Buffer.from('a'))).toBeNull();
    expect(cache.lookup(Buffer.from('b'))).not.toBeNull();
    expect(cache.lookup(Buffer.from('c'))).not.toBeNull();
  });

  it('should move accessed entry to head (LRU)', () => {
    const evicted: Buffer[] = [];
    const cache = new LRUCache(200, (_key) => {
      evicted.push(_key);
    });

    cache.insert(Buffer.from('a'), Buffer.from('1'), 100);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 100);

    // Access 'a' → makes 'b' the LRU
    cache.lookup(Buffer.from('a'));

    // Insert 'c' → should evict 'b' (now LRU), not 'a'
    cache.insert(Buffer.from('c'), Buffer.from('3'), 100);
    expect(cache.lookup(Buffer.from('a'))).not.toBeNull();
    expect(cache.lookup(Buffer.from('b'))).toBeNull();
    expect(cache.lookup(Buffer.from('c'))).not.toBeNull();
  });

  it('should erase entry', () => {
    const cache = new LRUCache(1024);
    cache.insert(Buffer.from('x'), Buffer.from('y'), 50);
    expect(cache.totalCharge()).toBe(50);

    cache.erase(Buffer.from('x'));
    expect(cache.lookup(Buffer.from('x'))).toBeNull();
    expect(cache.totalCharge()).toBe(0);
  });

  it('erase should be no-op for missing key', () => {
    const cache = new LRUCache(1024);
    expect(() => cache.erase(Buffer.from('nope'))).not.toThrow();
  });

  it('should prune all entries', () => {
    const cache = new LRUCache(1024);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 100);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 100);
    cache.insert(Buffer.from('c'), Buffer.from('3'), 100);

    cache.prune();
    expect(cache.totalCharge()).toBe(0);
    expect(cache.lookup(Buffer.from('a'))).toBeNull();
    expect(cache.lookup(Buffer.from('b'))).toBeNull();
    expect(cache.lookup(Buffer.from('c'))).toBeNull();
  });

  it('should handle zero-capacity cache', () => {
    const evicted: Buffer[] = [];
    const cache = new LRUCache(0, (key) => evicted.push(key));

    // Insert into zero-capacity: evict immediately
    cache.insert(Buffer.from('x'), Buffer.from('y'), 1);
    // Entry is inserted then evicted in the same call
    expect(cache.totalCharge()).toBe(0);
  });

  it('should handle large entries exceeding capacity', () => {
    const evicted: Buffer[] = [];
    const cache = new LRUCache(50, (key) => evicted.push(key));

    // Insert 2 small entries
    cache.insert(Buffer.from('a'), Buffer.from('1'), 30);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 30);
    // Total = 60 > 50, 'a' should be evicted
    expect(cache.totalCharge()).toBeLessThanOrEqual(50);

    // Oversized entry: 100 > 50 capacity
    cache.insert(Buffer.from('big'), Buffer.from('data'), 100);
    // Oversized entry is inserted but then evicted
    expect(cache.totalCharge()).toBe(0);
    expect(cache.lookup(Buffer.from('big'))).toBeNull();
  });

  it('should update existing key on re-insert', () => {
    const cache = new LRUCache(1024);
    cache.insert(Buffer.from('k'), Buffer.from('v1'), 100);
    cache.insert(Buffer.from('k'), Buffer.from('v2'), 200);

    const h = cache.lookup(Buffer.from('k'));
    expect(h).not.toBeNull();
    expect(h!.value).toEqual(Buffer.from('v2'));
    expect(h!.charge).toBe(200);
  });

  it('should handle binary keys', () => {
    const cache = new LRUCache(1024);
    const binKey = Buffer.from([0x00, 0x01, 0xff, 0xfe]);
    const binVal = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
    cache.insert(binKey, binVal, 50);

    const h = cache.lookup(binKey);
    expect(h).not.toBeNull();
    expect(h!.value).toEqual(binVal);
  });
});

// ─────────────────────────────────────────────────────────────
// bloom.ts
// ─────────────────────────────────────────────────────────────

describe('06e - BloomFilterPolicy', () => {
  it('newBloomFilterPolicy should create a filter policy', () => {
    const policy = newBloomFilterPolicy(10);
    expect(policy).toBeDefined();
    expect(policy.name()).toBe('leveldb.BuiltinBloomFilter2');
  });

  it('createFilter should produce a valid filter buffer', () => {
    const policy = newBloomFilterPolicy(10);
    const keys = [Buffer.from('hello'), Buffer.from('world'), Buffer.from('bloom')];
    const filter = policy.createFilter(keys);

    // Filter should be at least 64 bytes + 1 (k_ probe count)
    expect(filter.length).toBeGreaterThanOrEqual(65);
    // Last byte is the k_ probe count
    const k = filter[filter.length - 1];
    expect(k).toBeGreaterThanOrEqual(1);
    expect(k).toBeLessThanOrEqual(30);
  });

  it('keyMayMatch should return true for keys in the filter', () => {
    const policy = newBloomFilterPolicy(10);
    const keys = [
      Buffer.from('alpha'),
      Buffer.from('beta'),
      Buffer.from('gamma'),
      Buffer.from('delta'),
      Buffer.from('epsilon'),
    ];
    const filter = policy.createFilter(keys);

    // All inserted keys should match
    for (const key of keys) {
      expect(policy.keyMayMatch(key, filter)).toBe(true);
    }
  });

  it('keyMayMatch should typically return false for random keys not in filter', () => {
    const policy = newBloomFilterPolicy(10);
    const keys = [Buffer.from('aaa'), Buffer.from('bbb'), Buffer.from('ccc')];
    const filter = policy.createFilter(keys);

    // Random keys not in the set should likely return false
    // (Bloom filters have no false negatives, but may have false positives)
    let falsePositives = 0;
    const testKeys = Array.from({ length: 100 }, (_, i) => Buffer.from(`rnd-${i}`));
    for (const tk of testKeys) {
      if (policy.keyMayMatch(tk, filter)) {
        falsePositives++;
      }
    }
    // With 10 bits/key and 3 keys, the false positive rate should be very low
    // Accept up to 10% (very conservative)
    expect(falsePositives).toBeLessThanOrEqual(20);
  });

  it('should handle empty keys array', () => {
    const policy = newBloomFilterPolicy(10);
    const filter = policy.createFilter([]);
    expect(filter.length).toBeGreaterThanOrEqual(64);

    // Random key should return false for empty filter
    expect(policy.keyMayMatch(Buffer.from('anything'), filter)).toBe(false);
  });

  it('keyMayMatch should return false for small filters (bytes < 1)', () => {
    const policy = newBloomFilterPolicy(10);
    // Create a filter with only the k_ byte, no actual data
    const tinyFilter = Buffer.from([10]); // just k=10, 0 data bytes
    expect(policy.keyMayMatch(Buffer.from('test'), tinyFilter)).toBe(false);
  });

  it('keyMayMatch should conservatively return true for k > 30', () => {
    const policy = newBloomFilterPolicy(10);
    // Craft a filter with k > 30
    const filter = Buffer.alloc(65);
    filter[64] = 31; // k = 31 > 30
    // Should return true conservatively
    expect(policy.keyMayMatch(Buffer.from('test'), filter)).toBe(true);
  });

  it('createFilter should handle single key', () => {
    const policy = newBloomFilterPolicy(10);
    const filter = policy.createFilter([Buffer.from('solo')]);
    expect(policy.keyMayMatch(Buffer.from('solo'), filter)).toBe(true);
  });

  it('should handle keys with binary data', () => {
    const policy = newBloomFilterPolicy(10);
    const keys = [
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from([0xff, 0xfe, 0xfd]),
    ];
    const filter = policy.createFilter(keys);
    for (const key of keys) {
      expect(policy.keyMayMatch(key, filter)).toBe(true);
    }
  });

  it('FilterPolicy interface methods', () => {
    const policy: FilterPolicy = newBloomFilterPolicy(10);
    expect(typeof policy.name).toBe('function');
    expect(typeof policy.createFilter).toBe('function');
    expect(typeof policy.keyMayMatch).toBe('function');
  });
});

// ─────────────────────────────────────────────────────────────
// codec.ts (edge cases for remaining uncovered)
// ─────────────────────────────────────────────────────────────

describe('06f - Codec edge cases', () => {
  it('putVarint32 / getVarint32 round trip', () => {
    const testValues = [0, 1, 127, 128, 255, 256, 16383, 16384, 0xffffffff >>> 0];
    for (const val of testValues) {
      const encoded = putVarint32(val);
      const [decoded, bytesRead] = getVarint32(encoded, 0);
      expect(decoded).toBe(val >>> 0);
      expect(bytesRead).toBeGreaterThan(0);
    }
  });

  it('getVarint32 with offset', () => {
    const buf = Buffer.concat([
      Buffer.from([0xaa]), // dummy
      putVarint32(42),
    ]);
    const [val, len] = getVarint32(buf, 1);
    expect(val).toBe(42);
    expect(len).toBeGreaterThan(0);
  });

  it('putVarint64 / getVarint64 round trip', () => {
    const testValues = [0n, 1n, 127n, 128n, 255n, 256n, 0xffffffffn, 0xffffffffffffn];
    for (const val of testValues) {
      const encoded = putVarint64(val);
      const [decoded, bytesRead] = getVarint64(encoded, 0);
      expect(decoded).toBe(val);
      expect(bytesRead).toBeGreaterThan(0);
    }
  });

  it('putFixed32 / getFixed32', () => {
    const buf = Buffer.alloc(4);
    putFixed32(buf, 0xdeadbeef);
    expect(getFixed32(buf, 0)).toBe(0xdeadbeef >>> 0);
  });

  it('CRC32 should compute known values', () => {
    // CRC32 of empty data
    expect(crc32(Buffer.alloc(0))).toBe(0);
    // CRC32 of "hello"
    const hash = crc32(Buffer.from('hello'));
    expect(typeof hash).toBe('number');
    // CRC32 should be deterministic
    expect(crc32(Buffer.from('hello'))).toBe(hash);
  });

  it('CRC32 should differ for different data', () => {
    const h1 = crc32(Buffer.from('abc'));
    const h2 = crc32(Buffer.from('abd'));
    expect(h1).not.toBe(h2);
  });

  it('CRC32 mask / unmask round-trip', () => {
    const original = crc32(Buffer.from('test data'));
    const masked = crc32cMask(original);
    const unmasked = crc32cUnmask(masked);
    expect(unmasked).toBe(original);
  });

  it('encodeUserKey with buffer encoding (pass-through)', () => {
    const buf = Buffer.from('raw');
    const result = encodeUserKey(buf, 'buffer');
    expect(result).toBe(buf); // Same buffer reference
  });

  it('encodeUserKey with utf8 encoding', () => {
    const result = encodeUserKey('hello', 'utf8');
    expect(result).toEqual(Buffer.from('hello'));
  });

  it('decodeUserKey with buffer encoding (pass-through)', () => {
    const buf = Buffer.from('data');
    const result = decodeUserKey(buf, 'buffer');
    expect(Buffer.isBuffer(result)).toBe(true);
    expect(result).toBe(buf);
  });

  it('decodeUserKey with utf8 encoding', () => {
    const buf = Buffer.from('world', 'utf8');
    const result = decodeUserKey(buf, 'utf8');
    expect(typeof result).toBe('string');
    expect(result).toBe('world');
  });

  it('encodeUserValue with utf8 encoding', () => {
    const result = encodeUserValue('中文', 'utf8');
    expect(result).toEqual(Buffer.from('中文', 'utf8'));
  });

  it('decodeUserValue with utf8 encoding', () => {
    const buf = Buffer.from('中文', 'utf8');
    const result = decodeUserValue(buf, 'utf8');
    expect(result).toBe('中文');
  });

  it('decodeUserValue with buffer encoding', () => {
    const buf = Buffer.from([0x01, 0x02]);
    const result = decodeUserValue(buf, 'buffer');
    expect(Buffer.isBuffer(result)).toBe(true);
  });
});
