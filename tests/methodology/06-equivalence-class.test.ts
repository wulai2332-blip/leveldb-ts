/**
 * 等价类划分测试 (Equivalence Class Partitioning)
 * 将输入数据分成等价类，每个等价类选取代表性数据测试。
 * 覆盖模块: codec, types, comparator, bloom, cache, write_batch, memtable
 */
import { describe, it, expect } from 'vitest';
import { putVarint32, getVarint32, putVarint64, getVarint64 } from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { LRUCache } from '../../src/cache.js';
import { WriteBatch } from '../../src/write_batch.js';
import { MemTable } from '../../src/memtable.js';

// ─── Varint 等价类 ───
// 有效等价类: 1字节值 [0, 127], 2字节 [128, 16383], 3字节 [16384, 2097151],
//             4字节 [2097152, 268435455], 5字节 [268435456, 0xFFFFFFFF]
describe('Varint32 Equivalence Class', () => {
  const classes = {
    '1-byte [0, 127]': [0, 1, 63, 127],
    '2-byte [128, 16383]': [128, 200, 10000, 16383],
    '3-byte [16384, 2097151]': [16384, 100000, 2097151],
    '4-byte [2097152, 268435455]': [2097152, 100000000, 268435455],
    '5-byte [268435456, 0xFFFFFFFF]': [268435456, 3000000000, 0xffffffff],
  };

  for (const [className, values] of Object.entries(classes)) {
    for (const v of values) {
      it(`${className}: ${v}`, () => {
        const buf = putVarint32(v);
        const [decoded] = getVarint32(buf);
        expect(decoded).toBe(v);
      });
    }
  }
});

// ─── InternalKey 等价类 ───
describe('InternalKey Equivalence Class', () => {
  // Partition by key characteristics
  const keyClasses = {
    'short ascii': [Buffer.from('a'), Buffer.from('key'), Buffer.from('hello')],
    'numeric-like': [Buffer.from('001'), Buffer.from('12345')],
    'binary with nulls': [Buffer.from([0x00, 0x01]), Buffer.from([0x00, 0x00, 0xff])],
    'unicode': [Buffer.from('测试'), Buffer.from('🔥')],
    'long': [Buffer.alloc(100, 0x41), Buffer.alloc(4096, 0x42)],
  };

  for (const [className, keys] of Object.entries(keyClasses)) {
    for (const key of keys) {
      it(`should round-trip ${className}: len=${key.length}`, () => {
        for (const vt of [ValueType.Value, ValueType.Deletion]) {
          const ik = encodeInternalKey(key, 100n, vt);
          const decoded = decodeInternalKey(ik);
          expect(decoded.userKey).toEqual(key);
          expect(decoded.valueType).toBe(vt);
        }
      });
    }
  }
});

// ─── Comparator 等价类 ───
describe('Comparator Equivalence Class', () => {
  const cmp = new BytewiseComparator();

  // Partition: a < b, a == b, a > b
  it('a < b: different first byte', () => {
    expect(cmp.compare(Buffer.from('a'), Buffer.from('b'))).toBeLessThan(0);
  });

  it('a < b: a is prefix of b', () => {
    expect(cmp.compare(Buffer.from('abc'), Buffer.from('abcd'))).toBeLessThan(0);
  });

  it('a == b: identical', () => {
    expect(cmp.compare(Buffer.from('test'), Buffer.from('test'))).toBe(0);
  });

  it('a == b: both empty', () => {
    expect(cmp.compare(Buffer.alloc(0), Buffer.alloc(0))).toBe(0);
  });

  it('a > b: different first byte', () => {
    expect(cmp.compare(Buffer.from('z'), Buffer.from('a'))).toBeGreaterThan(0);
  });

  it('a > b: b is prefix of a', () => {
    expect(cmp.compare(Buffer.from('abcd'), Buffer.from('abc'))).toBeGreaterThan(0);
  });

  // findShortSuccessor equivalence classes
  it('findShortSuccessor: all 0xFF bytes → append', () => {
    const r = cmp.findShortSuccessor(Buffer.from([0xff]));
    expect(r.length).toBe(2);
  });

  it('findShortSuccessor: can increment last byte', () => {
    const r = cmp.findShortSuccessor(Buffer.from('hello'));
    expect(Buffer.compare(r, Buffer.from('hello'))).toBeGreaterThan(0);
  });
});

// ─── LRUCache 容量等价类 ───
describe('LRUCache Capacity Equivalence Class', () => {
  // Partition: zero, tiny, small, medium, large capacity
  it('tiny capacity (1): can only hold 1 unit', () => {
    const cache = new LRUCache(1);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 1);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 1);
    expect(cache.lookup(Buffer.from('a'))).toBeNull();
    expect(cache.lookup(Buffer.from('b'))).not.toBeNull();
  });

  it('small capacity (10): eviction on 11th unit', () => {
    const cache = new LRUCache(10);
    for (let i = 0; i < 10; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 1);
    }
    expect(cache.totalCharge()).toBe(10);
    cache.insert(Buffer.from('k10'), Buffer.from('v10'), 1);
    expect(cache.totalCharge()).toBe(10);
    expect(cache.lookup(Buffer.from('k0'))).toBeNull(); // oldest evicted
  });

  it('large capacity: holds many entries', () => {
    const cache = new LRUCache(1000);
    for (let i = 0; i < 500; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 1);
    }
    expect(cache.totalCharge()).toBe(500);
  });
});

// ─── WriteBatch 等价类 ───
describe('WriteBatch Equivalence Class', () => {
  // Partition by operation types
  it('put-only batch', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.put(Buffer.from('k2'), Buffer.from('v2'));
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    let count = 0;
    decoded.iterate(() => { count++; });
    expect(count).toBe(2);
  });

  it('delete-only batch', () => {
    const batch = new WriteBatch();
    batch.delete(Buffer.from('k1'));
    batch.delete(Buffer.from('k2'));
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    let count = 0;
    decoded.iterate(() => { count++; });
    expect(count).toBe(2);
  });

  it('mixed put+delete batch', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k1'), Buffer.from('v1'));
    batch.delete(Buffer.from('k1'));
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    let count = 0;
    decoded.iterate(() => { count++; });
    expect(count).toBe(2);
  });

  it('clear then empty', () => {
    const batch = new WriteBatch();
    batch.put(Buffer.from('k'), Buffer.from('v'));
    batch.clear();
    expect(batch.approxSize()).toBe(0);
  });
});

// ─── MemTable 操作等价类 ───
describe('MemTable Operation Equivalence Class', () => {
  const cmp = new BytewiseComparator();

  it('put then get: value returned', () => {
    const mem = new MemTable(cmp);
    mem.add(1n, ValueType.Value, Buffer.from('key'), Buffer.from('value'));
    const result = mem.get(Buffer.from('key'), 1n);
    expect(result).not.toBeNull();
    expect(result!.value).toEqual(Buffer.from('value'));
    expect(result!.valueType).toBe(ValueType.Value);
  });

  it('delete then get: deletion returned', () => {
    const mem = new MemTable(cmp);
    mem.add(1n, ValueType.Deletion, Buffer.from('key'), Buffer.alloc(0));
    const result = mem.get(Buffer.from('key'), 1n);
    expect(result).not.toBeNull();
    expect(result!.valueType).toBe(ValueType.Deletion);
  });

  it('get non-existent: null', () => {
    const mem = new MemTable(cmp);
    expect(mem.get(Buffer.from('nonexistent'), 1n)).toBeNull();
  });

  it('snapshot isolation: older snapshot sees nothing', () => {
    const mem = new MemTable(cmp);
    mem.add(10n, ValueType.Value, Buffer.from('key'), Buffer.from('value'));
    // Snapshot at sequence 5 should not see entry added at 10
    const result = mem.get(Buffer.from('key'), 5n);
    expect(result).toBeNull();
  });

  it('newer snapshot sees entry', () => {
    const mem = new MemTable(cmp);
    mem.add(10n, ValueType.Value, Buffer.from('key'), Buffer.from('value'));
    const result = mem.get(Buffer.from('key'), 15n);
    expect(result).not.toBeNull();
  });
});
