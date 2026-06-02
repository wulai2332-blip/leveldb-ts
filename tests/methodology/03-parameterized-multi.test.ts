/**
 * 参数化测试 (Parameterized Testing)
 * 使用多组数据测试同一逻辑，覆盖不同输入组合。
 * 覆盖模块: codec, comparator, types, bloom, block, memtable, cache
 */
import { describe, it, expect } from 'vitest';
import { putVarint32, getVarint32, putVarint64, getVarint64, crc32 } from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { LRUCache } from '../../src/cache.js';

// ─── Varint32 多值参数化 ───
describe('Varint32 Parameterized', () => {
  const testCases = [
    { value: 0, expectedBytes: 1 },
    { value: 1, expectedBytes: 1 },
    { value: 127, expectedBytes: 1 },
    { value: 128, expectedBytes: 2 },
    { value: 16383, expectedBytes: 2 },
    { value: 16384, expectedBytes: 3 },
    { value: 2097151, expectedBytes: 3 },
    { value: 2097152, expectedBytes: 4 },
    { value: 268435455, expectedBytes: 4 },
    { value: 268435456, expectedBytes: 5 },
    { value: 0xffffffff, expectedBytes: 5 },
  ];

  for (const { value, expectedBytes } of testCases) {
    it(`should encode ${value} in ${expectedBytes} byte(s)`, () => {
      const buf = putVarint32(value);
      expect(buf.length).toBe(expectedBytes);
      const [decoded] = getVarint32(buf);
      expect(decoded).toBe(value);
    });
  }
});

// ─── Varint64 多值参数化 ───
describe('Varint64 Parameterized', () => {
  const values = [
    0n, 1n, 127n, 128n, 255n, 16383n, 16384n,
    0xffffffffn, 0x100000000n, 0xffffffffffffffffn,
  ];

  for (const v of values) {
    it(`should round-trip ${v}`, () => {
      const buf = putVarint64(v);
      const [decoded] = getVarint64(buf);
      expect(decoded).toBe(v);
    });
  }
});

// ─── CRC32 多字符串参数化 ───
describe('CRC32 Parameterized', () => {
  // Test deterministicity: same input → same output
  const inputs = ['', 'hello', 'world', 'LevelDB', 'test'];

  for (const input of inputs) {
    it(`crc32("${input}") should be deterministic`, () => {
      const c1 = crc32(Buffer.from(input));
      const c2 = crc32(Buffer.from(input));
      expect(c1).toBe(c2);
      expect(typeof c1).toBe('number');
    });
  }
});

// ─── InternalKey 多序列号参数化 ───
describe('InternalKey Parameterized', () => {
  // Max valid sequence is (2^56 - 1) due to 8-bit ValueType packing
  const sequences = [0n, 1n, 10n, 100n, 1000n, 0xffffffffn, 0x00ffffffffffffn];

  for (const seq of sequences) {
    it(`should round-trip with sequence ${seq}`, () => {
      const uk = Buffer.from('testkey');
      const ik = encodeInternalKey(uk, seq, ValueType.Value);
      const decoded = decodeInternalKey(ik);
      expect(decoded.userKey).toEqual(uk);
      expect(decoded.sequence).toBe(seq);
      expect(decoded.valueType).toBe(ValueType.Value);
    });
  }

  const keys = [
    Buffer.from(''),
    Buffer.from('a'),
    Buffer.from('hello'),
    Buffer.from('key_with_unicode_🔥'),
    Buffer.alloc(1000, 0x41), // 1KB of 'A'
  ];

  for (const key of keys) {
    it(`should preserve key length ${key.length}`, () => {
      const ik = encodeInternalKey(key, 42n, ValueType.Value);
      const { userKey } = decodeInternalKey(ik);
      expect(userKey).toEqual(key);
    });
  }
});

// ─── Comparator 多字节对比 ───
describe('Comparator Parameterized', () => {
  const cmp = new BytewiseComparator();

  const pairs: [Buffer, Buffer, number][] = [
    [Buffer.from('a'), Buffer.from('b'), -1],
    [Buffer.from('b'), Buffer.from('a'), 1],
    [Buffer.from('a'), Buffer.from('a'), 0],
    [Buffer.from('abc'), Buffer.from('abd'), -1],
    [Buffer.from(''), Buffer.from('a'), -1],
    [Buffer.from('abc'), Buffer.from('abc\x00'), -1],
    [Buffer.from([0xff, 0xff]), Buffer.from([0xff, 0xff]), 0],
  ];

  for (const [a, b, expected] of pairs) {
    it(`compare(${a.toString('hex')}, ${b.toString('hex')}) = ${expected}`, () => {
      const result = cmp.compare(a, b);
      if (expected === -1) expect(result).toBeLessThan(0);
      else if (expected === 1) expect(result).toBeGreaterThan(0);
      else expect(result).toBe(0);
    });
  }
});

// ─── Bloom Filter 多 key 数量参数化 ───
describe('BloomFilter Parameterized', () => {
  const keyCounts = [1, 5, 10, 50, 100];

  for (const count of keyCounts) {
    it(`should handle ${count} keys`, () => {
      const filter = newBloomFilterPolicy(10);
      const keys = Array.from({ length: count }, (_, i) => Buffer.from(`key${i}`));
      const bloom = filter.createFilter(keys);
      expect(bloom.length).toBeGreaterThan(0);
      // All inserted keys should match
      for (const key of keys) {
        expect(filter.keyMayMatch(key, bloom)).toBe(true);
      }
    });
  }
});

// ─── BlockBuilder 多条目参数化 ───
describe('BlockBuilder Parameterized', () => {
  const entryCounts = [0, 1, 10, 50, 100, 500];

  for (const count of entryCounts) {
    it(`should handle ${count} entries`, () => {
      const bb = new BlockBuilder(16);
      for (let i = 0; i < count; i++) {
        bb.add(Buffer.from(`key${i.toString().padStart(4, '0')}`), Buffer.from(`val${i}`));
      }
      const data = bb.finish();
      const block = new Block(data);
      const iter = block.iterator(new BytewiseComparator());
      let n = 0;
      for (iter.seekToFirst(); iter.valid(); iter.next()) n++;
      expect(n).toBe(count);
    });
  }

  const restartIntervals = [1, 4, 8, 16, 32];

  for (const interval of restartIntervals) {
    it(`should work with restartInterval=${interval}`, () => {
      const bb = new BlockBuilder(interval);
      for (let i = 0; i < 100; i++) {
        bb.add(Buffer.from(`k${i}`), Buffer.from(`v${i}`));
      }
      const data = bb.finish();
      expect(data.length).toBeGreaterThan(0);
    });
  }
});

// ─── LRUCache 不同容量参数化 ───
describe('LRUCache Parameterized', () => {
  const capacities = [1, 10, 50, 100, 500];

  for (const cap of capacities) {
    it(`should work with capacity=${cap}`, () => {
      const cache = new LRUCache(cap);
      for (let i = 0; i < cap * 2; i++) {
        cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 1);
      }
      expect(cache.totalCharge()).toBeLessThanOrEqual(cap);
    });
  }
});

// ─── SkipList 大量插入参数化 ───
describe('SkipList Parameterized', () => {
  const sizes = [10, 100, 500, 1000];

  for (const size of sizes) {
    it(`should maintain order with ${size} elements`, () => {
      const arena = new Arena();
      const list = new SkipList(new BytewiseComparator(), arena);
      // Insert in reverse order
      for (let i = size - 1; i >= 0; i--) {
        list.insert(Buffer.from(`k${i.toString().padStart(6, '0')}`), Buffer.from(`v${i}`));
      }
      const iter = list.iterator();
      iter.seekToFirst();
      let prev = '';
      let count = 0;
      while (iter.valid()) {
        const cur = iter.key().toString();
        expect(cur > prev).toBe(true);
        prev = cur;
        count++;
        iter.next();
      }
      expect(count).toBe(size);
    });
  }
});
