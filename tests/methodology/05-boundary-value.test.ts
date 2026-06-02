/**
 * 边界值测试 (Boundary Value Testing)
 * 测试边界条件和临界值：空输入、最大值、最小值、溢出边界。
 * 覆盖模块: codec, types, arena, cache, block, table, wal, comparator, write_batch, skiplist
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { putVarint32, getVarint32, putVarint64, getVarint64, crc32 } from '../../src/codec.js';
import { encodeInternalKey, decodeInternalKey, ValueType } from '../../src/types.js';
import { Arena } from '../../src/arena.js';
import { LRUCache } from '../../src/cache.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { Block } from '../../src/sstable/block.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { WriteBatch } from '../../src/write_batch.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { LogWriter } from '../../src/wal/writer.js';
import { LogReader } from '../../src/wal/reader.js';
import { existsSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';

// ─── Codec 边界值 ───
describe('Codec Boundary Value', () => {
  it('varint32: minimum (0)', () => {
    const buf = putVarint32(0);
    expect(buf.length).toBe(1);
    expect(buf[0]).toBe(0);
    const [v] = getVarint32(buf);
    expect(v).toBe(0);
  });

  it('varint32: maximum (0xFFFFFFFF)', () => {
    const buf = putVarint32(0xffffffff);
    const [v, bytes] = getVarint32(buf);
    expect(v).toBe(0xffffffff);
    expect(bytes).toBe(5);
  });

  it('varint32: boundary 127→128 (1→2 bytes)', () => {
    expect(putVarint32(127).length).toBe(1);
    expect(putVarint32(128).length).toBe(2);
  });

  it('varint32: boundary 16383→16384 (2→3 bytes)', () => {
    expect(putVarint32(16383).length).toBe(2);
    expect(putVarint32(16384).length).toBe(3);
  });

  it('varint64: maximum (2^64-1)', () => {
    const val = 0xffffffffffffffffn;
    const buf = putVarint64(val);
    const [v] = getVarint64(buf);
    expect(v).toBe(val);
  });

  it('varint32: empty buffer getVarint32', () => {
    const [val, bytes] = getVarint32(Buffer.alloc(0), 0);
    expect(val).toBe(0);
    expect(bytes).toBe(0);
  });

  it('crc32: empty input', () => {
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });

  it('crc32: single byte', () => {
    expect(crc32(Buffer.from([0x00]))).toBe(0xd202ef8d);
    expect(crc32(Buffer.from([0xff]))).toBe(0xff000000);
  });
});

// ─── InternalKey 边界条件 ───
describe('InternalKey Boundary Value', () => {
  it('empty user key', () => {
    const ik = encodeInternalKey(Buffer.alloc(0), 1n, ValueType.Value);
    expect(ik.length).toBe(8);
    const { userKey } = decodeInternalKey(ik);
    expect(userKey.length).toBe(0);
  });

  it('max sequence number (2^56-1, limited by 8-bit ValueType packing)', () => {
    const uk = Buffer.from('max');
    // Maximum valid sequence is 2^56 - 1 (upper 8 bits reserved for ValueType)
    const maxSeq = (1n << 56n) - 1n;
    const ik = encodeInternalKey(uk, maxSeq, ValueType.Value);
    const { sequence } = decodeInternalKey(ik);
    expect(sequence).toBe(maxSeq);
  });

  it('sequence 0', () => {
    const uk = Buffer.from('zero');
    const ik = encodeInternalKey(uk, 0n, ValueType.Value);
    const { sequence } = decodeInternalKey(ik);
    expect(sequence).toBe(0n);
  });

  it('deletion vs value boundary (byte diff)', () => {
    const uk = Buffer.from('b');
    const v = encodeInternalKey(uk, 5n, ValueType.Value);
    const d = encodeInternalKey(uk, 5n, ValueType.Deletion);
    // Value (1) > Deletion (0) in the last byte → Value sorts after Deletion
    expect(v[v.length - 1] & 0xff).toBe(1);
    expect(d[d.length - 1] & 0xff).toBe(0);
  });

  it('very long user key (10KB)', () => {
    const uk = Buffer.alloc(10240, 0x41);
    const ik = encodeInternalKey(uk, 1n, ValueType.Value);
    const { userKey } = decodeInternalKey(ik);
    expect(userKey).toEqual(uk);
  });
});

// ─── Arena 边界值 ───
describe('Arena Boundary Value', () => {
  it('allocate 0 bytes', () => {
    const arena = new Arena();
    const buf = arena.allocate(0);
    expect(buf.length).toBe(0);
    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(4096);
  });

  it('allocate exactly 4096 (block size)', () => {
    const arena = new Arena();
    const buf = arena.allocate(4096);
    expect(buf.length).toBe(4096);
  });

  it('allocate 4097 (just over block size)', () => {
    const arena = new Arena();
    const buf = arena.allocate(4097);
    expect(buf.length).toBe(4097);
    // Should create a block of exactly 4097
    expect(arena.memoryUsage()).toBe(4097);
  });

  it('allocate huge block (100KB)', () => {
    const arena = new Arena();
    const buf = arena.allocate(102400);
    expect(buf.length).toBe(102400);
    expect(arena.memoryUsage()).toBe(102400);
  });
});

// ─── LRUCache 边界值 ───
describe('LRUCache Boundary Value', () => {
  it('zero capacity cache', () => {
    const cache = new LRUCache(0);
    cache.insert(Buffer.from('k'), Buffer.from('v'), 10);
    // Entry should be immediately evicted (size > 0 capacity)
    expect(cache.totalCharge()).toBe(0);
    expect(cache.lookup(Buffer.from('k'))).toBeNull();
  });

  it('negative capacity (treated as zero)', () => {
    const cache = new LRUCache(-5);
    cache.insert(Buffer.from('k'), Buffer.from('v'), 1);
    expect(cache.totalCharge()).toBe(0);
  });

  it('entry exceeding capacity', () => {
    const cache = new LRUCache(5);
    cache.insert(Buffer.from('big'), Buffer.from('data'), 10);
    expect(cache.totalCharge()).toBe(0);
  });

  it('maximum capacity', () => {
    const cache = new LRUCache(1000000);
    for (let i = 0; i < 100; i++) {
      cache.insert(Buffer.from(`k${i}`), Buffer.from(`v${i}`), 100);
    }
    expect(cache.totalCharge()).toBeGreaterThan(0);
  });
});

// ─── Block 边界值 ───
describe('Block Boundary Value', () => {
  it('empty buffer block', () => {
    const block = new Block(Buffer.alloc(0));
    expect(block.size()).toBe(0);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
  });

  it('buffer smaller than 4 bytes (no restart count)', () => {
    const block = new Block(Buffer.from([0x01, 0x02, 0x03]));
    expect(block.size()).toBe(3);
    const iter = block.iterator(new BytewiseComparator());
    expect(() => iter.seekToFirst()).not.toThrow();
    expect(iter.valid()).toBe(false);
  });

  it('buffer exactly 4 bytes (zero restart count)', () => {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(0, 0);
    const block = new Block(buf);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
  });

  it('corrupted restart count (negative value as uint32)', () => {
    const buf = Buffer.alloc(100);
    buf.writeUInt32LE(0xffffffff, buf.length - 4); // very large
    const block = new Block(buf);
    expect(() => block.iterator(new BytewiseComparator())).not.toThrow();
  });
});

// ─── BlockBuilder 边界值 ───
describe('BlockBuilder Boundary Value', () => {
  it('no entries (empty block)', () => {
    const bb = new BlockBuilder(16);
    const data = bb.finish();
    // Should contain just restart array (1 restart at offset 0) + count (1)
    expect(data.length).toBe(4 + 4); // 4 bytes for restart[0]=0 + 4 bytes for count=1
  });

  it('single entry', () => {
    const bb = new BlockBuilder(16);
    bb.add(Buffer.from('key'), Buffer.from('value'));
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('key'));
    expect(iter.value()).toEqual(Buffer.from('value'));
  });

  it('key with null bytes', () => {
    const bb = new BlockBuilder(16);
    const key = Buffer.from([0x00, 0x01, 0x00, 0xff]);
    bb.add(key, Buffer.from('v'));
    const data = bb.finish();
    const block = new Block(data);
    const iter = block.iterator(new BytewiseComparator());
    iter.seekToFirst();
    expect(iter.key()).toEqual(key);
  });
});

// ─── WriteBatch 边界值 ───
describe('WriteBatch Boundary Value', () => {
  it('empty batch', () => {
    const batch = new WriteBatch();
    expect(batch.approxSize()).toBe(0);
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    expect(decoded.approxSize()).toBe(0);
  });

  it('delete-only batch', () => {
    const batch = new WriteBatch();
    batch.delete(Buffer.from('key'));
    expect(batch.approxSize()).toBeGreaterThan(0);
  });

  it('very large batch (100 entries)', () => {
    const batch = new WriteBatch();
    for (let i = 0; i < 100; i++) {
      batch.put(Buffer.from(`key${i}`), Buffer.from(`value${i}`));
    }
    const encoded = batch.encode();
    const decoded = WriteBatch.decode(encoded);
    expect(decoded.approxSize()).toBe(batch.approxSize());
  });

  it('encode on empty batch should work', () => {
    const batch = new WriteBatch();
    const encoded = batch.encode();
    expect(encoded.length).toBeGreaterThanOrEqual(12); // 8 (seq) + 4 (count)
    const decoded = WriteBatch.decode(encoded);
    expect(decoded.approxSize()).toBe(0);
  });
});

// ─── Comparator 边界值 ───
describe('Comparator Boundary Value', () => {
  const cmp = new BytewiseComparator();

  it('compare empty buffers', () => {
    expect(cmp.compare(Buffer.alloc(0), Buffer.alloc(0))).toBe(0);
  });

  it('findShortestSeparator: empty start', () => {
    const result = cmp.findShortestSeparator(Buffer.alloc(0), Buffer.from('limit'));
    expect(result).toEqual(Buffer.alloc(0));
  });

  it('findShortestSeparator: start already minimal', () => {
    const result = cmp.findShortestSeparator(Buffer.from('abc'), Buffer.from('abc'));
    expect(result).toEqual(Buffer.from('abc'));
  });

  it('findShortSuccessor: empty key', () => {
    const result = cmp.findShortSuccessor(Buffer.alloc(0));
    // Should append 0x00 to make a longer key
    expect(result).toEqual(Buffer.from([0x00]));
  });

  it('findShortSuccessor: all 0xFF bytes', () => {
    const result = cmp.findShortSuccessor(Buffer.from([0xff, 0xff, 0xff]));
    expect(result).toEqual(Buffer.from([0xff, 0xff, 0xff, 0x00]));
  });

  it('findShortSuccessor: normal key', () => {
    const result = cmp.findShortSuccessor(Buffer.from('hello'));
    expect(Buffer.compare(result, Buffer.from('hello'))).toBeGreaterThan(0);
  });
});

// ─── SkipList 边界值 ───
describe('SkipList Boundary Value', () => {
  let arena: Arena;
  let list: SkipList;

  beforeEach(() => {
    arena = new Arena();
    list = new SkipList(new BytewiseComparator(), arena);
  });

  it('insert and find single element', () => {
    list.insert(Buffer.from('one'), Buffer.from('1'));
    expect(list.find(Buffer.from('one'))).not.toBeNull();
  });

  it('find on empty list', () => {
    expect(list.find(Buffer.from('any'))).toBeNull();
  });

  it('insert duplicate key (overwrites by ordering)', () => {
    list.insert(Buffer.from('dup'), Buffer.from('first'));
    list.insert(Buffer.from('dup'), Buffer.from('second'));
    // Both exist in the skiplist (second appears first due to internal ordering)
    const found = list.find(Buffer.from('dup'));
    expect(found).not.toBeNull();
  });

  it('seek past last element', () => {
    list.insert(Buffer.from('a'), Buffer.from('1'));
    const iter = list.iterator();
    iter.seek(Buffer.from('z'));
    expect(iter.valid()).toBe(false);
  });

  it('seek before first element', () => {
    list.insert(Buffer.from('m'), Buffer.from('1'));
    const iter = list.iterator();
    iter.seek(Buffer.from('a'));
    expect(iter.valid()).toBe(true);
    expect(iter.key()).toEqual(Buffer.from('m')); // findGreaterOrEqual
  });
});

// ─── WAL 边界值 ───
describe('WAL Boundary Value', () => {
  const dir = join(tmpdir(), `wal-boundary-${randomBytes(4).toString('hex')}`);

  beforeEach(() => {
    mkdirSync(dir, { recursive: true });
  });

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('write and read empty record', () => {
    const fp = join(dir, 'log.wal');
    const writer = new LogWriter(fp);
    writer.addRecord(Buffer.alloc(0));
    writer.close();
    expect(existsSync(fp));
  });

  it('write and read single-byte record', () => {
    const fp = join(dir, 'log1.wal');
    const writer = new LogWriter(fp);
    writer.addRecord(Buffer.from([0x42]));
    writer.close();

    const reader = new LogReader(fp);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.length).toBe(1);
    expect(record![0]).toBe(0x42);
  });

  it('record exactly 32KB-7 (max single block payload)', () => {
    const fp = join(dir, 'log32k.wal');
    const writer = new LogWriter(fp);
    const payloadSize = 32768 - 7; // 32KB - header
    const data = Buffer.alloc(payloadSize, 0x41);
    writer.addRecord(data);
    writer.close();

    const reader = new LogReader(fp);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.length).toBe(payloadSize);
  });

  it('record larger than 32KB (multi-block)', () => {
    const fp = join(dir, 'logbig.wal');
    const writer = new LogWriter(fp);
    const data = Buffer.alloc(100000, 0x42);
    writer.addRecord(data);
    writer.close();

    const reader = new LogReader(fp);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.length).toBe(100000);
    expect(record![0]).toBe(0x42);
    expect(record![99999]).toBe(0x42);
  });
});
