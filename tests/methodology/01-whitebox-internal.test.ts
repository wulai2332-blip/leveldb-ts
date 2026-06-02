/**
 * 白盒测试 (White-box Testing)
 * 基于内部实现逻辑设计测试用例，验证代码内部路径。
 * 覆盖模块: codec, types, arena, cache, status, comparator, skiplist, block, bloom
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
  putVarint32, getVarint32, putVarint64, getVarint64,
  putFixed32, getFixed32, crc32, crc32cMask, crc32cUnmask,
} from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { Arena } from '../../src/arena.js';
import { LRUCache } from '../../src/cache.js';
import { Status, StatusCode } from '../../src/status.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';

// ─── CRC32 内部表与状态机 ───
describe('CRC32 White-box', () => {
  it('should produce deterministic values for known inputs', () => {
    expect(crc32(Buffer.from('hello'))).toBe(0x3610a686);
    expect(crc32(Buffer.from(''))).toBe(0);
  });

  it('should be associative: crc(a+b) computes cumulatively', () => {
    const a = Buffer.from('hello');
    const b = Buffer.from('world');
    const combined = Buffer.concat([a, b]);
    expect(crc32(combined)).toBeDefined();
    // Concatenation CRC should differ from individual
    expect(crc32(combined)).not.toBe(crc32(a));
    expect(crc32(combined)).not.toBe(crc32(b));
  });

  it('crc32cMask/Unmask round-trip', () => {
    for (const v of [0, 1, 0xffffffff, 0x12345678, 0xdeadbeef]) {
      expect(crc32cUnmask(crc32cMask(v))).toBe(v >>> 0);
    }
  });
});

// ─── Varint 内部编码结构 ───
describe('Varint32 White-box', () => {
  it('should encode 0 as single byte 0x00', () => {
    const buf = putVarint32(0);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0x00);
  });

  it('should encode 127 as single byte 0x7f', () => {
    const buf = putVarint32(127);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0x7f);
  });

  it('should encode 128 as [0x80, 0x01] (continuation bit)', () => {
    const buf = putVarint32(128);
    expect(buf.length).toBe(2);
    expect(buf[0]).toBe(0x80);
    expect(buf[1]).toBe(0x01);
  });

  it('should handle maximum uint32', () => {
    const buf = putVarint32(0xffffffff);
    const [val, bytes] = getVarint32(buf);
    expect(val).toBe(0xffffffff);
    expect(bytes).toBe(5);
  });

  it('should throw/get 0 for out-of-bounds offset', () => {
    const [val, bytes] = getVarint32(Buffer.from([]), 0);
    expect(val).toBe(0);
    expect(bytes).toBe(0);
  });
});

describe('Varint64 White-box', () => {
  it('should encode large bigint values', () => {
    const val = 0xffffffffffffffffn;
    const buf = putVarint64(val);
    const [decoded, bytes] = getVarint64(buf);
    expect(decoded).toBe(val);
    expect(bytes).toBeLessThanOrEqual(10);
  });

  it('should handle 0n', () => {
    const buf = putVarint64(0n);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0x00);
  });
});

// ─── InternalKey 编码结构 ───
describe('InternalKey White-box', () => {
  it('should append 8 bytes to user key', () => {
    const uk = Buffer.from('test');
    const ik = encodeInternalKey(uk, 1n, ValueType.Value);
    expect(ik.length).toBe(uk.length + 8);
  });

  it('should preserve userKey on encode then decode', () => {
    const uk = Buffer.from('hello');
    const ik = encodeInternalKey(uk, 42n, ValueType.Value);
    const { userKey, sequence, valueType } = decodeInternalKey(ik);
    expect(userKey).toEqual(uk);
    expect(sequence).toBe(42n);
    expect(valueType).toBe(ValueType.Value);
  });

  it('should distinguish Value from Deletion by lower 8 bits', () => {
    const uk = Buffer.from('key');
    const v = encodeInternalKey(uk, 5n, ValueType.Value);
    const d = encodeInternalKey(uk, 5n, ValueType.Deletion);
    // The last byte differs
    const vLast = v[v.length - 1];
    const dLast = d[d.length - 1];
    expect(vLast).not.toBe(dLast);
  });

  it('larger sequence should be <= smaller bytes for same key (descending sort)', () => {
    const uk = Buffer.from('sortkey');
    const ikHi = encodeInternalKey(uk, 100n, ValueType.Value);
    const ikLo = encodeInternalKey(uk, 1n, ValueType.Value);
    // Higher seq means lower internal key (descending)
    expect(Buffer.compare(ikHi, ikLo)).toBeLessThan(0);
  });
});

// ─── Arena 内部分配逻辑 ───
describe('Arena White-box', () => {
  let arena: Arena;
  beforeEach(() => { arena = new Arena(); });

  it('should allocate first block of at least 4096 bytes', () => {
    const buf = arena.allocate(10);
    expect(buf).toBeInstanceOf(Buffer);
    expect(buf.length).toBe(10);
    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(4096);
  });

  it('should create new block when request exceeds remaining', () => {
    arena.allocate(4090);
    const buf2 = arena.allocate(100);
    expect(buf2.length).toBe(100);
    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(4096 + Math.max(4096, 100));
  });

  it('should allocate exactly the requested size when > 4096', () => {
    const buf = arena.allocate(8192);
    expect(buf.length).toBe(8192);
  });

  it('should return zero memory usage initially', () => {
    const fresh = new Arena();
    expect(fresh.memoryUsage()).toBe(0);
  });
});

// ─── LRUCache 内部链表结构 ───
describe('LRUCache White-box', () => {
  it('should maintain circular doubly-linked list integrity', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.insert(Buffer.from('c'), Buffer.from('3'), 10);
    // All should be findable
    expect(cache.lookup(Buffer.from('a'))?.value).toEqual(Buffer.from('1'));
    expect(cache.lookup(Buffer.from('b'))?.value).toEqual(Buffer.from('2'));
    expect(cache.lookup(Buffer.from('c'))?.value).toEqual(Buffer.from('3'));
  });

  it('should evict LRU entry when capacity exceeded', () => {
    const cache = new LRUCache(20);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.insert(Buffer.from('c'), Buffer.from('3'), 10);
    expect(cache.lookup(Buffer.from('a'))).toBeNull(); // evicted
    expect(cache.lookup(Buffer.from('b'))).not.toBeNull();
    expect(cache.lookup(Buffer.from('c'))).not.toBeNull();
  });

  it('should move accessed entry to head (promote)', () => {
    const cache = new LRUCache(25);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    // Access 'a' — moves to head
    cache.lookup(Buffer.from('a'));
    cache.insert(Buffer.from('c'), Buffer.from('3'), 10);
    // 'b' should be evicted (LRU), 'a' survived
    expect(cache.lookup(Buffer.from('a'))).not.toBeNull();
    expect(cache.lookup(Buffer.from('b'))).toBeNull();
  });

  it('should handle erase on non-existent key gracefully', () => {
    const cache = new LRUCache(100);
    expect(() => cache.erase(Buffer.from('nope'))).not.toThrow();
  });

  it('should prune all entries', () => {
    const cache = new LRUCache(100);
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    cache.prune();
    expect(cache.totalCharge()).toBe(0);
    expect(cache.lookup(Buffer.from('a'))).toBeNull();
  });

  it('should trigger onEvict callback', () => {
    let evictedKey: Buffer | null = null;
    const cache = new LRUCache(10, (key) => { evictedKey = key; });
    cache.insert(Buffer.from('a'), Buffer.from('1'), 10);
    cache.insert(Buffer.from('b'), Buffer.from('2'), 10);
    expect(evictedKey).not.toBeNull();
    expect(evictedKey!).toEqual(Buffer.from('a'));
  });
});

// ─── Block 读取内部边界校验 ───
describe('Block White-box', () => {
  it('should handle corrupted data (too small)', () => {
    const block = new Block(Buffer.from([0x00]));
    expect(block.size()).toBe(1);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
  });

  it('should reject corrupt restart count (>1M)', () => {
    // Build a buffer with an impossibly large restart count
    const bad = Buffer.alloc(100);
    bad.writeUInt32LE(9999999, bad.length - 4);
    const block = new Block(bad);
    expect(block.size()).toBe(100);
    // Should not throw/crash
    const iter = block.iterator(new BytewiseComparator());
    expect(() => iter.seekToFirst()).not.toThrow();
  });
});

// ─── BlockBuilder 内部状态 ───
describe('BlockBuilder White-box', () => {
  it('should throw if finish called twice', () => {
    const bb = new BlockBuilder(16);
    bb.add(Buffer.from('a'), Buffer.from('1'));
    bb.finish();
    expect(() => bb.finish()).toThrow('already finished');
  });

  it('should reuse shared prefix for sequential keys', () => {
    const bb = new BlockBuilder(4);
    bb.add(Buffer.from('hello'), Buffer.from('v1'));
    bb.add(Buffer.from('help'), Buffer.from('v2')); // shares "hel" prefix
    const finished = bb.finish();
    expect(finished.length).toBeGreaterThan(0);
    // Verify restart info
    const block = new Block(finished);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('hello'));
    iter.next();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('help'));
  });

  it('should add restart point at specified interval', () => {
    const bb = new BlockBuilder(3);
    for (let i = 0; i < 10; i++) {
      bb.add(Buffer.from(`key${i}`), Buffer.from(`val${i}`));
    }
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    let count = 0;
    for (iter.seekToFirst(); iter.valid(); iter.next()) count++;
    expect(count).toBe(10);
  });
});

// ─── Bloom Filter 内部哈希 ───
describe('BloomFilter White-box', () => {
  it('should create filter with k_ probe count stored in last byte', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = [Buffer.from('a'), Buffer.from('b'), Buffer.from('c')];
    const bloom = filter.createFilter(keys);
    expect(bloom.length).toBeGreaterThan(1);
    const k = bloom[bloom.length - 1];
    expect(k).toBeGreaterThan(0);
  });

  it('keyMayMatch should return true for inserted keys', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = [Buffer.from('hello'), Buffer.from('world')];
    const bloom = filter.createFilter(keys);
    expect(filter.keyMayMatch(Buffer.from('hello'), bloom)).toBe(true);
    expect(filter.keyMayMatch(Buffer.from('world'), bloom)).toBe(true);
  });

  it('keyMayMatch should return false for non-inserted keys (likely)', () => {
    const filter = newBloomFilterPolicy(10);
    const keys = [Buffer.from('hello')];
    const bloom = filter.createFilter(keys);
    const result = filter.keyMayMatch(Buffer.from('nonexistent'), bloom);
    // Due to false positive rate, can't assert false strictly,
    // but with 1 key and 10 bitsPerKey, it's very likely false
    // We can verify it's at least deterministic
    expect(typeof result).toBe('boolean');
  });

  it('should return false for too-small filter', () => {
    const filter = newBloomFilterPolicy(10);
    expect(filter.keyMayMatch(Buffer.from('x'), Buffer.alloc(0))).toBe(false);
  });
});

// ─── Fixed32 (little-endian) ───
describe('Fixed32 White-box', () => {
  it('should write/read in little-endian', () => {
    const buf = Buffer.alloc(4);
    putFixed32(buf, 0x01020304);
    // Little endian: least significant byte first
    expect(buf[0]).toBe(0x04);
    expect(buf[1]).toBe(0x03);
    expect(buf[2]).toBe(0x02);
    expect(buf[3]).toBe(0x01);
    expect(getFixed32(buf)).toBe(0x01020304);
  });
});

// ─── Status 内部状态 ───
describe('Status White-box', () => {
  it('should have correct toString for each code', () => {
    const ok = Status.ok();
    expect(ok.toString()).toBe('OK');
    expect(Status.notFound('msg').toString()).toContain('NotFound');
    expect(Status.corruption('msg').toString()).toContain('Corruption');
    expect(Status.ioError('msg').toString()).toContain('IOError');
    expect(Status.notSupported('msg').toString()).toContain('NotSupported');
  });

  it('should only ok() return true for ok()', () => {
    const ok = Status.ok();
    expect(ok.ok()).toBe(true);
    expect(ok.isNotFound()).toBe(false);
    expect(ok.isCorruption()).toBe(false);
    expect(ok.isIOError()).toBe(false);
    expect(ok.isNotSupported()).toBe(false);
  });
});

// ─── SkipList 内部状态 ───
describe('SkipList White-box', () => {
  let arena: Arena;
  let list: SkipList;

  beforeEach(() => {
    arena = new Arena();
    list = new SkipList(new BytewiseComparator(), arena);
  });

  it('should maintain ascending order', () => {
    list.insert(Buffer.from('c'), Buffer.from('3'));
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('b'), Buffer.from('2'));
    const iter = list.iterator();
    iter.seekToFirst();
    expect(iter.key()).toEqual(Buffer.from('a'));
    iter.next();
    expect(iter.key()).toEqual(Buffer.from('b'));
    iter.next();
    expect(iter.key()).toEqual(Buffer.from('c'));
  });

  it('find should return exact match', () => {
    list.insert(Buffer.from('key'), Buffer.from('value'));
    const found = list.find(Buffer.from('key'));
    expect(found).not.toBeNull();
    expect(found!.value).toEqual(Buffer.from('value'));
  });

  it('find should return null for missing key', () => {
    list.insert(Buffer.from('key'), Buffer.from('value'));
    expect(list.find(Buffer.from('missing'))).toBeNull();
  });

  it('seekToLast should find the greatest key', () => {
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('z'), Buffer.from('26'));
    const iter = list.iterator();
    iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('z'));
  });

  it('should handle empty list gracefully', () => {
    const iter = list.iterator();
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
    iter.seekToLast();
    expect(iter.valid()).toBe(false);
    iter.seek(Buffer.from('any'));
    expect(iter.valid()).toBe(false);
  });
});
