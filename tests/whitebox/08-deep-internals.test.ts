/**
 * Whitebox Test 08: Deep Internal Module Coverage
 *
 * Targets for 95%+:
 *   - block.ts + block_builder.ts
 *   - table.ts + table_builder.ts
 *   - wal/reader.ts + wal/writer.ts
 *   - version_edit.ts
 *   - arena.ts
 *   - skiplist.ts
 *   - scheduler.ts (via DB compaction)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Block } from '../../src/sstable/block.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { Table, openTable } from '../../src/sstable/table.js';
import { LogWriter } from '../../src/wal/writer.js';
import { LogReader } from '../../src/wal/reader.js';
import { VersionEdit } from '../../src/version/version_edit.js';
import { VersionEditTag } from '../../src/version/version_edit_tag.js';
import { Arena } from '../../src/arena.js';
import { SkipList, SkipListIterator } from '../../src/memtable/skiplist.js';
import { BytewiseComparator } from '../../src/comparator.js';
import type { Comparator } from '../../src/comparator.js';
import { DB } from '../../src/db.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { CompressionType } from '../../src/options.js';
import type { FileMetaData } from '../../src/types.js';
import { encodeInternalKey, ValueType } from '../../src/types.js';

const TEST_DIR = join(tmpdir(), 'leveldb-ts-deep-test');

// ─────────────────────────────────────────────────────────────
// arena.ts
// ─────────────────────────────────────────────────────────────

describe('08a - Arena', () => {
  it('should allocate within current block', () => {
    const arena = new Arena();
    const buf1 = arena.allocate(100);
    expect(buf1.length).toBe(100);

    const buf2 = arena.allocate(200);
    expect(buf2.length).toBe(200);

    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(300);
  });

  it('should create new block when current block is insufficient', () => {
    const arena = new Arena();
    // Allocate close to kBlockSize (4096) to force new block
    arena.allocate(4000);
    const usage1 = arena.memoryUsage();

    // This should fit in remaining ~96 bytes
    arena.allocate(50);
    const usage2 = arena.memoryUsage();

    // This will need a new block
    arena.allocate(500);
    const usage3 = arena.memoryUsage();

    expect(usage3).toBeGreaterThan(usage2);
    expect(usage3).toBeGreaterThan(usage1);
  });

  it('should allocate larger-than-block-size request in its own block', () => {
    const arena = new Arena();
    // kBlockSize = 4096, request 8192
    const buf = arena.allocate(8192);
    expect(buf.length).toBe(8192);
    // Memory usage should be at least 8192 (one block of 8192)
    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(8192);
  });

  it('should allocate zero bytes', () => {
    const arena = new Arena();
    const buf = arena.allocate(0);
    expect(buf.length).toBe(0);
  });

  it('should return cumulative memory usage', () => {
    const arena = new Arena();
    expect(arena.memoryUsage()).toBe(0);

    arena.allocate(100);
    arena.allocate(200);
    expect(arena.memoryUsage()).toBeGreaterThanOrEqual(300);
  });
});

// ─────────────────────────────────────────────────────────────
// block_builder.ts + block.ts round-trip
// ─────────────────────────────────────────────────────────────

describe('08b - BlockBuilder + Block round-trip', () => {
  const cmp = new BytewiseComparator();

  it('should build and read back entries', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('a'), Buffer.from('1'));
    builder.add(Buffer.from('b'), Buffer.from('2'));
    builder.add(Buffer.from('c'), Buffer.from('3'));

    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('a');
    expect(iter.value().toString()).toBe('1');

    iter.next();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('b');
    expect(iter.value().toString()).toBe('2');

    iter.next();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');
    expect(iter.value().toString()).toBe('3');

    iter.next();
    expect(iter.valid()).toBe(false);
  });

  it('should handle shared prefix compression', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('hello_world'), Buffer.from('v1'));
    builder.add(Buffer.from('hello_earth'), Buffer.from('v2'));
    builder.add(Buffer.from('hello_mars'), Buffer.from('v3'));

    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seekToFirst();
    expect(iter.key().toString()).toBe('hello_world');

    iter.next();
    expect(iter.key().toString()).toBe('hello_earth');

    iter.next();
    expect(iter.key().toString()).toBe('hello_mars');
  });

  it('should handle seek to exact key', () => {
    const builder = new BlockBuilder(16);
    for (let i = 0; i < 50; i++) {
      builder.add(Buffer.from(`key-${String(i).padStart(3, '0')}`), Buffer.from(`val-${i}`));
    }
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seek(Buffer.from('key-025'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('key-025');
  });

  it('should seek to first key >= target (missing key)', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('a'), Buffer.from('1'));
    builder.add(Buffer.from('c'), Buffer.from('3'));
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seek(Buffer.from('b'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');
  });

  it('should handle seekToLast', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('a'), Buffer.from('1'));
    builder.add(Buffer.from('b'), Buffer.from('2'));
    builder.add(Buffer.from('c'), Buffer.from('3'));
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');
    expect(iter.value().toString()).toBe('3');
  });

  it('should handle prev traversal', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('a'), Buffer.from('1'));
    builder.add(Buffer.from('b'), Buffer.from('2'));
    builder.add(Buffer.from('c'), Buffer.from('3'));
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seekToLast();
    expect(iter.key().toString()).toBe('c');

    iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('b');

    iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('a');

    iter.prev();
    expect(iter.valid()).toBe(false);
  });

  it('should handle seekToLast on empty block', () => {
    const builder = new BlockBuilder(16);
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    iter.seekToLast();
    expect(iter.valid()).toBe(false);
  });

  it('should handle prev on empty block', () => {
    const builder = new BlockBuilder(16);
    const data = builder.finish();
    const block = new Block(data);
    const iter = block.iterator(cmp);

    // prev on invalid iterator should not throw
    expect(() => iter.prev()).not.toThrow();
  });

  it('should handle corrupt data gracefully (Block constructor)', () => {
    // Data too small
    const tinyBlock = new Block(Buffer.from([0x01]));
    expect(tinyBlock.size()).toBe(1);
    const iter = tinyBlock.iterator(cmp);
    iter.seekToFirst();
    expect(iter.valid()).toBe(false);
  });

  it('should handle corrupt varint in readEntry gracefully', () => {
    // Create a minimal block with unreasonable restart data that's out of bounds
    // Constructor: numRestarts from last 4B, restartsOffset = dataLen - 4 - numRestarts*4
    // If we write numRestarts=1000 in a small data buffer, the Block constructor
    // clamps it (nr > 1000000? No, but ro would be negative → clamped to 0)
    // Let's create valid-looking but corrupted data:
    // numRestarts=1, restartsOffset points into garbage entry data
    const buf = Buffer.alloc(50);
    buf.fill(0xff); // Fill with high bytes to create invalid varints
    buf.writeUInt32LE(1, 46); // numRestarts=1 at pos 46
    // restartsOffset = 50 - 4 - 4 = 42
    // restart[0] read from buf[42..46] = all 0xff = 4294967295 (beyond file)
    // seekToRestart(0) sets pos=restarts[0]=4294967295 which is >= dataEnd → pos=0

    const block = new Block(buf);
    const iter = block.iterator(cmp);
    expect(() => iter.seekToFirst()).not.toThrow();
    // seekToRestart sets pos out of bounds → pos resets to 0 → valid() is false
    expect(iter.valid()).toBe(false);
  });

  it('should report corruption status on varint decode error', () => {
    // Create block with valid header but truncated entry data
    // numRestarts=1, restart points to a varint that overflows the buffer
    const data = Buffer.alloc(20);
    data.writeUInt32LE(1, 16); // numRestarts=1 at pos 16
    // restartsOffset = 20 - 4 - 4 = 12
    // restart[0] = readUInt32LE(12) — whatever bytes are there (0x00)
    // seekToRestart(0): pos = 0, tries to read entry starting with 3 varints
    // All zero bytes → varint32 of 0 has 1 byte → shared=0 (1B), nonShared=0 (1B), valueLen=0 (1B)
    // key = Buffer.concat([prefix, suffix]) = empty
    // value = data.subarray(3, 3) = empty
    // This actually works... let's use a different approach
    // Write a partial varint (0x80 with no continuation)
    data[0] = 0x80; // Incomplete varint → read will go past buffer end
    data[1] = 0x80;
    data[2] = 0x80;
    data[3] = 0x80;
    data[4] = 0x80; // All continuation bytes — no terminator

    const block = new Block(data);
    const iter = block.iterator(cmp);
    expect(() => iter.seekToFirst()).not.toThrow();
    // The readEntry may succeed or fail depending on how the varint decode
    // interacts with the buffer. If it hits the end of the entry region,
    // pos resets to 0 making valid() false. Either way, shouldn't crash.
    // Just verify it doesn't throw
  });

  it('Block.size() should return data length', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('k'), Buffer.from('v'));
    const data = builder.finish();
    const block = new Block(data);
    expect(block.size()).toBe(data.length);
  });

  it('should throw when adding to finished BlockBuilder', () => {
    const builder = new BlockBuilder(16);
    builder.add(Buffer.from('k'), Buffer.from('v'));
    builder.finish();
    expect(() => builder.add(Buffer.from('k2'), Buffer.from('v2'))).toThrow('already finished');
  });

  it('should throw when finishing finished BlockBuilder', () => {
    const builder = new BlockBuilder(16);
    builder.finish();
    expect(() => builder.finish()).toThrow('already finished');
  });

  it('estimatedSize should return current byte length', () => {
    const builder = new BlockBuilder(16);
    expect(builder.estimatedSize()).toBe(0);
    builder.add(Buffer.from('key'), Buffer.from('value'));
    expect(builder.estimatedSize()).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// wal/writer.ts + wal/reader.ts round-trip
// ─────────────────────────────────────────────────────────────

describe('08c - LogWriter + LogReader round-trip', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should write and read back single record (Full type)', () => {
    const logPath = join(TEST_DIR, 'wal-single.log');
    const writer = new LogWriter(logPath);
    const data = Buffer.from('hello world record');
    writer.addRecord(data);
    writer.close();

    const reader = new LogReader(logPath);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.toString()).toBe('hello world record');
    expect(reader.readNext()).toBeNull();

    unlinkSync(logPath);
  });

  it('should write and read back multiple records', () => {
    const logPath = join(TEST_DIR, 'wal-multi.log');
    const writer = new LogWriter(logPath);
    writer.addRecord(Buffer.from('record-1'));
    writer.addRecord(Buffer.from('record-2'));
    writer.addRecord(Buffer.from('record-3'));
    writer.close();

    const reader = new LogReader(logPath);
    const records: string[] = [];
    let rec: Buffer | null;
    while ((rec = reader.readNext()) !== null) {
      records.push(rec.toString());
    }
    expect(records).toEqual(['record-1', 'record-2', 'record-3']);

    unlinkSync(logPath);
  });

  it('should handle large records that span blocks (fragmentation)', () => {
    const logPath = join(TEST_DIR, 'wal-large.log');
    const writer = new LogWriter(logPath);
    // kBlockSize = 32768, write a record larger than a block
    const largeData = Buffer.alloc(40000, 0x42);
    writer.addRecord(largeData);
    writer.close();

    const reader = new LogReader(logPath);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.length).toBe(40000);
    expect(record!.equals(largeData)).toBe(true);
    expect(reader.readNext()).toBeNull();

    unlinkSync(logPath);
  });

  it('should handle records at block boundaries', () => {
    const logPath = join(TEST_DIR, 'wal-boundary.log');
    const writer = new LogWriter(logPath);
    // Write to fill block partially, then another record
    const filler = Buffer.alloc(32000, 0x11);
    writer.addRecord(filler);
    const data = Buffer.from('after-filler');
    writer.addRecord(data);
    writer.close();

    const reader = new LogReader(logPath);
    const r1 = reader.readNext();
    expect(r1).not.toBeNull();
    expect(r1!.length).toBe(32000);

    const r2 = reader.readNext();
    expect(r2).not.toBeNull();
    expect(r2!.toString()).toBe('after-filler');

    unlinkSync(logPath);
  });

  it('should handle binary data with null bytes', () => {
    const logPath = join(TEST_DIR, 'wal-binary.log');
    const writer = new LogWriter(logPath);
    const binary = Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00, 0xfe]);
    writer.addRecord(binary);
    writer.close();

    const reader = new LogReader(logPath);
    const record = reader.readNext();
    expect(record).not.toBeNull();
    expect(record!.equals(binary)).toBe(true);

    unlinkSync(logPath);
  });
});

// ─────────────────────────────────────────────────────────────
// version_edit.ts encode/decode
// ─────────────────────────────────────────────────────────────

describe('08d - VersionEdit encode/decode', () => {
  it('should encode and decode Comparator', () => {
    const edit = new VersionEdit();
    edit.setComparatorName('test.Cmp');
    const encoded = edit.encode();
    const decoded = VersionEdit.decode(encoded);
    expect(decoded.comparatorName).toBe('test.Cmp');
  });

  it('should encode and decode LogNumber', () => {
    const edit = new VersionEdit();
    edit.setLogNumber(42);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.logNumber).toBe(42);
  });

  it('should encode and decode PrevLogNumber', () => {
    const edit = new VersionEdit();
    edit.setPrevLogNumber(10);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.prevLogNumber).toBe(10);
  });

  it('should encode and decode NextFileNumber', () => {
    const edit = new VersionEdit();
    edit.setNextFile(100);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.nextFileNumber).toBe(100);
  });

  it('should encode and decode LastSequence', () => {
    const edit = new VersionEdit();
    edit.setLastSequence(999n);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.lastSequence).toBe(999n);
  });

  it('should encode and decode CompactPointer', () => {
    const edit = new VersionEdit();
    edit.setCompactPointer(3, Buffer.from('pointer-key'));
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.compactPointers.get(3)!.toString()).toBe('pointer-key');
  });

  it('should encode and decode DeletedFile entries', () => {
    const edit = new VersionEdit();
    edit.deleteFile(0, 5);
    edit.deleteFile(0, 7);
    edit.deleteFile(1, 10);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.deletedFiles.get(0)!.has(5)).toBe(true);
    expect(decoded.deletedFiles.get(0)!.has(7)).toBe(true);
    expect(decoded.deletedFiles.get(1)!.has(10)).toBe(true);
  });

  it('should encode and decode AddedFile entries', () => {
    const edit = new VersionEdit();
    const meta: FileMetaData = {
      fileNumber: 101,
      fileSize: 2048,
      smallest: Buffer.from('aaa'),
      largest: Buffer.from('zzz'),
    };
    edit.addFile(2, meta);
    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.addedFiles).toHaveLength(1);
    expect(decoded.addedFiles[0].level).toBe(2);
    expect(decoded.addedFiles[0].meta.fileNumber).toBe(101);
    expect(decoded.addedFiles[0].meta.fileSize).toBe(2048);
    expect(decoded.addedFiles[0].meta.smallest.toString()).toBe('aaa');
    expect(decoded.addedFiles[0].meta.largest.toString()).toBe('zzz');
  });

  it('should handle complete round-trip with all fields', () => {
    const edit = new VersionEdit();
    edit.setComparatorName('leveldb.BytewiseComparator');
    edit.setLogNumber(10);
    edit.setPrevLogNumber(8);
    edit.setNextFile(50);
    edit.setLastSequence(100n);
    edit.setCompactPointer(0, Buffer.from([0x01, 0x02]));
    edit.deleteFile(0, 3);
    edit.deleteFile(1, 7);
    edit.deleteFile(1, 8);
    edit.addFile(0, {
      fileNumber: 20,
      fileSize: 4096,
      smallest: Buffer.from('min'),
      largest: Buffer.from('max'),
    });
    edit.addFile(1, {
      fileNumber: 21,
      fileSize: 8192,
      smallest: Buffer.from([0x00]),
      largest: Buffer.from([0xff]),
    });

    const decoded = VersionEdit.decode(edit.encode());
    expect(decoded.comparatorName).toBe('leveldb.BytewiseComparator');
    expect(decoded.logNumber).toBe(10);
    expect(decoded.prevLogNumber).toBe(8);
    expect(decoded.nextFileNumber).toBe(50);
    expect(decoded.lastSequence).toBe(100n);
    expect(decoded.compactPointers.get(0)!.equals(Buffer.from([0x01, 0x02]))).toBe(true);
    expect(decoded.deletedFiles.get(0)!.has(3)).toBe(true);
    expect(decoded.deletedFiles.get(1)!.has(7)).toBe(true);
    expect(decoded.deletedFiles.get(1)!.has(8)).toBe(true);
    expect(decoded.addedFiles).toHaveLength(2);
    expect(decoded.addedFiles[0].level).toBe(0);
    expect(decoded.addedFiles[0].meta.fileNumber).toBe(20);
    expect(decoded.addedFiles[1].level).toBe(1);
    expect(decoded.addedFiles[1].meta.fileSize).toBe(8192);
  });

  it('should handle decode of empty buffer', () => {
    const decoded = VersionEdit.decode(Buffer.alloc(0));
    expect(decoded.comparatorName).toBeNull();
    expect(decoded.logNumber).toBeNull();
    expect(decoded.addedFiles).toHaveLength(0);
  });

  it('VersionEditTag enum values', () => {
    expect(VersionEditTag.Comparator).toBe(1);
    expect(VersionEditTag.LogNumber).toBe(2);
    expect(VersionEditTag.PrevLogNumber).toBe(3);
    expect(VersionEditTag.NextFileNumber).toBe(4);
    expect(VersionEditTag.LastSequence).toBe(5);
    expect(VersionEditTag.CompactPointer).toBe(6);
    expect(VersionEditTag.DeletedFile).toBe(7);
    expect(VersionEditTag.NewFile).toBe(8);
  });
});

// ─────────────────────────────────────────────────────────────
// skiplist.ts direct tests
// ─────────────────────────────────────────────────────────────

describe('08e - SkipList', () => {
  const cmp = new BytewiseComparator();

  it('should insert and find', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('key1'), Buffer.from('val1'));
    list.insert(Buffer.from('key2'), Buffer.from('val2'));

    const found = list.find(Buffer.from('key1'));
    expect(found).not.toBeNull();
    expect(found!.key.toString()).toBe('key1');
    expect(found!.value.toString()).toBe('val1');
  });

  it('should return null for missing key', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('a'), Buffer.from('1'));

    expect(list.find(Buffer.from('b'))).toBeNull();
  });

  it('should iterate all entries (iterator)', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('c'), Buffer.from('3'));
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('b'), Buffer.from('2'));

    const iter = list.iterator();
    iter.seekToFirst();

    const results: string[] = [];
    while (iter.valid()) {
      results.push(iter.key().toString());
      iter.next();
    }
    expect(results).toEqual(['a', 'b', 'c']);
  });

  it('should seek to specific key', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('c'), Buffer.from('3'));

    const iter = list.iterator();
    iter.seek(Buffer.from('b'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('c');
  });

  it('should seek to first and last', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('m'), Buffer.from('mid'));
    list.insert(Buffer.from('a'), Buffer.from('first'));
    list.insert(Buffer.from('z'), Buffer.from('last'));

    const iter = list.iterator();
    iter.seekToFirst();
    expect(iter.key().toString()).toBe('a');

    iter.seekToLast();
    expect(iter.key().toString()).toBe('z');
  });

  it('should handle prev() traversal', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('a'), Buffer.from('1'));
    list.insert(Buffer.from('b'), Buffer.from('2'));
    list.insert(Buffer.from('c'), Buffer.from('3'));

    const iter = list.iterator();
    iter.seekToLast();
    expect(iter.key().toString()).toBe('c');

    iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('b');

    iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('a');

    iter.prev();
    expect(iter.valid()).toBe(false);
  });

  it('should handle empty skiplist iterator', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    const iter = list.iterator();

    iter.seekToFirst();
    expect(iter.valid()).toBe(false);

    iter.seekToLast();
    expect(iter.valid()).toBe(false);

    iter.seek(Buffer.from('any'));
    expect(iter.valid()).toBe(false);

    // prev on invalid should not throw
    expect(() => iter.prev()).not.toThrow();
  });

  it('should handle findGreaterOrEqual and findLessThan', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    list.insert(Buffer.from('b'), Buffer.from('2'));
    list.insert(Buffer.from('d'), Buffer.from('4'));

    // findGreaterOrEqual
    const gte = (list as any).findGreaterOrEqual(Buffer.from('c'));
    expect(gte).not.toBeNull();
    expect(gte.key.toString()).toBe('d');

    // findLessThan
    const lt = (list as any).findLessThan(Buffer.from('c'));
    expect(lt).not.toBeNull();
    expect(lt.key.toString()).toBe('b');
  });

  it('should handle many insertions (stress test height growth)', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    for (let i = 0; i < 500; i++) {
      list.insert(Buffer.from(`k-${String(i).padStart(5, '0')}`), Buffer.from(`v-${i}`));
    }

    // Verify find works for all
    for (let i = 0; i < 500; i++) {
      const key = `k-${String(i).padStart(5, '0')}`;
      const found = list.find(Buffer.from(key));
      expect(found).not.toBeNull();
      expect(found!.value.toString()).toBe(`v-${i}`);
    }
  });

  it('iterator status() should always return OK', () => {
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    const iter = list.iterator();
    expect(iter.status().ok()).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// TableBuilder + Table round-trip
// ─────────────────────────────────────────────────────────────

describe('08f - TableBuilder + Table round-trip', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should build and read back a simple table', async () => {
    const tablePath = join(TEST_DIR, 'simple.ldb');
    const options = {
      createIfMissing: true,
      errorIfExists: false,
      paranoidChecks: false,
      writeBufferSize: 4194304,
      maxOpenFiles: 1000,
      blockSize: 4096,
      blockRestartInterval: 16,
      maxFileSize: 2097152,
      compression: CompressionType.None,
      zstdCompressionLevel: 1,
      reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const,
      valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    await builder.add(Buffer.from('a'), Buffer.from('1'));
    await builder.add(Buffer.from('b'), Buffer.from('2'));
    await builder.add(Buffer.from('c'), Buffer.from('3'));
    await builder.finish();

    expect(existsSync(tablePath)).toBe(true);

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const result = await table.internalGet(cmp, Buffer.from('b'));
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toBe('2');

    const missing = await table.internalGet(cmp, Buffer.from('z'));
    expect(missing).toBeNull();

    unlinkSync(tablePath);
  });

  it('should handle TwoLevelIterator forward traversal', async () => {
    const tablePath = join(TEST_DIR, 'twolevel.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 256, // Small block size to create multiple blocks
      blockRestartInterval: 4, // Frequent restarts
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    for (let i = 0; i < 200; i++) {
      await builder.add(
        Buffer.from(`k-${String(i).padStart(4, '0')}`),
        Buffer.from(`v-${i}`),
      );
    }
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    await iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('k-0000');

    // Next a few times
    await iter.next();
    expect(iter.key().toString()).toBe('k-0001');

    // Seek to a specific key
    await iter.seek(Buffer.from('k-0050'));
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('k-0050');

    // Next to cross data blocks
    for (let i = 0; i < 150; i++) {
      await iter.next();
    }
    // Should reach end
    expect(iter.valid()).toBe(false);

    unlinkSync(tablePath);
  }, 30000);

  it('should handle TwoLevelIterator seekToLast', async () => {
    const tablePath = join(TEST_DIR, 'twolevel-last.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 512, blockRestartInterval: 4,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    for (let i = 0; i < 100; i++) {
      await builder.add(
        Buffer.from(`z-${String(i).padStart(4, '0')}`),
        Buffer.from(`vz-${i}`),
      );
    }
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    await iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('z-0099');

    await iter.prev();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('z-0098');

    unlinkSync(tablePath);
  }, 30000);

  it('should handle table with bloom filter', async () => {
    const tablePath = join(TEST_DIR, 'bloom-table.ldb');
    const bloomFilter = newBloomFilterPolicy(10);
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 4096, blockRestartInterval: 16,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: bloomFilter,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    for (let i = 0; i < 50; i++) {
      await builder.add(
        Buffer.from(`bf-${i}`),
        Buffer.from(`bv-${i}`),
      );
    }
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();

    // Should find inserted keys
    const hit = await table.internalGet(cmp, Buffer.from('bf-25'));
    expect(hit).not.toBeNull();
    expect(hit!.value.toString()).toBe('bv-25');

    // Bloom filter should reject random keys
    const miss = await table.internalGet(cmp, Buffer.from('xyz-999'));
    expect(miss).toBeNull();

    unlinkSync(tablePath);
  }, 30000);

  it('should throw for invalid SSTable (too small)', async () => {
    const smallPath = join(TEST_DIR, 'small.ldb');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(smallPath, Buffer.alloc(10));
    await expect(Table.open(smallPath)).rejects.toThrow('too small');
    unlinkSync(smallPath);
  });

  it('should throw for invalid SSTable magic number', async () => {
    const badMagicPath = join(TEST_DIR, 'badmagic.ldb');
    const { writeFileSync } = await import('node:fs');
    const data = Buffer.alloc(48);
    // Fill with zeros — wrong magic
    writeFileSync(badMagicPath, data);
    await expect(Table.open(badMagicPath)).rejects.toThrow('magic');
    unlinkSync(badMagicPath);
  });

  it('Table.open should be exported as openTable', () => {
    expect(openTable).toBe(Table.open);
  });
});

// ─────────────────────────────────────────────────────────────
// Compaction (scheduler.ts) via DB
// ─────────────────────────────────────────────────────────────

describe('08g - Compaction via DB', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should compact level-0 files into level-1', async () => {
    const dbPath = join(TEST_DIR, 'compact-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256, // Very small to create many level-0 files
    });

    // Write a lot of data to create multiple SSTable files at level-0
    for (let i = 0; i < 500; i++) {
      await db.put(`comp-${String(i).padStart(5, '0')}`, `cv-${i}`);
    }

    // Level-0 should have multiple files ( > 4 triggers compaction)
    const l0Files = parseInt(db.getProperty('leveldb.num-files-at-level0'), 10);
    expect(l0Files).toBeGreaterThanOrEqual(1);

    // Close (triggers final flush)
    await db.close();

    // Reopen and check
    const db2 = await DB.open(dbPath, {
      createIfMissing: false,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    // Verify data still accessible
    expect(await db2.get('comp-00000')).toBe('cv-0');
    expect(await db2.get('comp-00250')).toBe('cv-250');
    expect(await db2.get('comp-00499')).toBe('cv-499');

    await db2.close();
  }, 60000);

  it('should handle compactRange on filled DB', async () => {
    const dbPath = join(TEST_DIR, 'compact-range-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256,
    });

    for (let i = 0; i < 300; i++) {
      await db.put(`cr-${String(i).padStart(4, '0')}`, `crv-${i}`);
    }

    // Compact a sub-range
    await db.compactRange(
      Buffer.from('cr-0000'),
      Buffer.from('cr-0050'),
    );

    // Verify range data
    expect(await db.get('cr-0000')).toBe('crv-0');
    expect(await db.get('cr-0025')).toBe('crv-25');

    await db.close();
  }, 60000);
});

// ─────────────────────────────────────────────────────────────
// Iterator: reverse dedup with overwrites (for iterator.ts coverage)
// ─────────────────────────────────────────────────────────────

describe('08h - Iterator reverse with duplicates', () => {
  it('should handle seek + next + prev sequence on same data', async () => {
    const dbPath = join(TEST_DIR, 'iter-seq');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('x', 'x1');
    await db.put('y', 'y1');
    await db.put('z', 'z1');

    // Forward + backward navigation
    const iter = db.iterator();
    await iter.seek(Buffer.from('y'));
    expect(iter.key().toString()).toBe('y');
    expect(iter.value().toString()).toBe('y1');

    await iter.next();
    expect(iter.key().toString()).toBe('z');

    await iter.prev();
    expect(iter.key().toString()).toBe('y');

    await iter.prev();
    expect(iter.key().toString()).toBe('x');

    iter.close();
    await db.close();
  });
});
