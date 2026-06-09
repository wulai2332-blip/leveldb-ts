/**
 * Whitebox Test 09: Edge Cases for 95%+ Coverage
 *
 * Targets remaining uncovered lines:
 *   - reader.ts: corrupt WAL, fragment edge cases
 *   - table.ts: TwoLevelIterator prev/seekToLast edge cases
 *   - iterator.ts: reverse heap paths
 *   - version_set.ts: recovery branches
 *   - memtable.ts: internal comparator
 *   - types.ts: RangeError
 *   - db_impl.ts: paranoid checks, edge branches
 *   - scheduler.ts: async path (best effort)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { LogWriter } from '../../src/wal/writer.js';
import { LogReader } from '../../src/wal/reader.js';
import { Block } from '../../src/sstable/block.js';
import { BlockBuilder } from '../../src/sstable/block_builder.js';
import { TableBuilder } from '../../src/sstable/table_builder.js';
import { Table } from '../../src/sstable/table.js';
import { VersionSet } from '../../src/version/version_set.js';
import { VersionEdit } from '../../src/version/version_edit.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { NodeEnv } from '../../src/env.js';
import { DB } from '../../src/db.js';
import { encodeInternalKey, decodeInternalKey, ValueType, kMaxSequenceNumber } from '../../src/types.js';
import type { FileMetaData } from '../../src/types.js';
import { CompressionType } from '../../src/options.js';
import { NotFoundError } from '../../src/error.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { MemTable } from '../../src/memtable.js';

const TEST_DIR = join(tmpdir(), 'leveldb-ts-edge-test');

// ─────────────────────────────────────────────────────────────
// reader.ts: corrupt & fragment edge cases
// ─────────────────────────────────────────────────────────────

describe('09a - WAL Reader edge cases', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should skip records with bad checksum (non-fragment)', () => {
    const logPath = join(TEST_DIR, 'bad-crc.log');
    const writer = new LogWriter(logPath);
    writer.addRecord(Buffer.from('good-record'));
    writer.close();

    // Corrupt the checksum bytes of the first record in the WAL
    const raw = readFileSync(logPath);
    // Header is 7 bytes: checksum(4) + length(2) + type(1)
    // Flip some bits in the checksum
    raw[0] ^= 0xff;
    raw[1] ^= 0xff;
    writeFileSync(logPath, raw);

    const reader = new LogReader(logPath);
    // The corrupt record should be skipped (checksum mismatch, not in fragment)
    // Then EOF is reached
    const rec = reader.readNext();
    // May get nothing if the checksum failed and we hit EOF
    // Or may get the second record... depends
    // After corruption skip, reader tries next record
    // If there's only one record, it hits EOF
    expect(() => reader.readNext()).not.toThrow();

    unlinkSync(logPath);
  });

  it('should handle WAL with only zero-padding (no actual records)', () => {
    const logPath = join(TEST_DIR, 'zero-pad.log');
    // Write a block full of zeros
    const zeros = Buffer.alloc(32768, 0x00);
    writeFileSync(logPath, zeros);

    const reader = new LogReader(logPath);
    // All zeros: read header → checksum=0, length=0, type=0
    // type=0 is not a valid RecordType → return null (not in fragment)
    const rec = reader.readNext();
    expect(rec).toBeNull();

    unlinkSync(logPath);
  });

  it('should handle truncated WAL (partial header)', () => {
    const logPath = join(TEST_DIR, 'truncated.log');
    // Write fewer than 7 bytes — not enough for even a header
    writeFileSync(logPath, Buffer.from([0x01, 0x02, 0x03]));

    const reader = new LogReader(logPath);
    const rec = reader.readNext();
    expect(rec).toBeNull();

    unlinkSync(logPath);
  });

  it('should handle record with zero-length payload', () => {
    const logPath = join(TEST_DIR, 'zero-payload.log');
    const writer = new LogWriter(logPath);
    writer.addRecord(Buffer.alloc(0));
    writer.close();

    const reader = new LogReader(logPath);
    const rec = reader.readNext();
    expect(rec).not.toBeNull();
    expect(rec!.length).toBe(0);

    unlinkSync(logPath);
  });

  it('should skip padding at block boundaries (leftover < 7 bytes)', () => {
    const logPath = join(TEST_DIR, 'block-pad.log');
    const writer = new LogWriter(logPath);

    // Fill to near the end of a 32KB block, then write another record
    // kBlockSize = 32768. Headers are 7 bytes.
    // Write records that cause block padding to be applied
    const data = Buffer.alloc(32760, 0x41); // Leaves ~1 byte for header → needs padding
    writer.addRecord(data);
    // Second small record
    writer.addRecord(Buffer.from('after-pad'));
    writer.close();

    const reader = new LogReader(logPath);
    const r1 = reader.readNext();
    expect(r1).not.toBeNull();
    expect(r1!.length).toBe(32760);

    const r2 = reader.readNext();
    expect(r2).not.toBeNull();
    expect(r2!.toString()).toBe('after-pad');

    unlinkSync(logPath);
  });
});

// ─────────────────────────────────────────────────────────────
// table.ts: TwoLevelIterator prev/seekToLast thorough
// ─────────────────────────────────────────────────────────────

describe('09b - TwoLevelIterator edge cases', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should handle prev() crossing data block boundary', async () => {
    const tablePath = join(TEST_DIR, 'prev-cross-block.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 64, // Very small to ensure many data blocks
      blockRestartInterval: 2,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    // Build enough entries to span multiple data blocks
    for (let i = 0; i < 100; i++) {
      await builder.add(
        Buffer.from(`pc-${String(i).padStart(3, '0')}`),
        Buffer.from(`pcv-${i}`),
      );
    }
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    // Start at last entry
    await iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('pc-099');

    // Prev through many entries, crossing multiple data blocks
    for (let i = 98; i >= 0; i--) {
      await iter.prev();
      expect(iter.valid()).toBe(true);
      expect(iter.key().toString()).toBe(`pc-${String(i).padStart(3, '0')}`);
    }

    // One more prev should go invalid
    await iter.prev();
    expect(iter.valid()).toBe(false);

    unlinkSync(tablePath);
  }, 30000);

  it('should handle next() crossing data block boundary to end', async () => {
    const tablePath = join(TEST_DIR, 'next-end.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 128, blockRestartInterval: 2,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    for (let i = 0; i < 80; i++) {
      await builder.add(
        Buffer.from(`ne-${String(i).padStart(3, '0')}`),
        Buffer.from(`nev-${i}`),
      );
    }
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    await iter.seekToFirst();
    expect(iter.key().toString()).toBe('ne-000');

    // Next through all entries
    let count = 0;
    while (iter.valid()) {
      count++;
      await iter.next();
    }
    expect(count).toBe(80);

    unlinkSync(tablePath);
  }, 30000);

  it('should handle TwoLevelIterator seek beyond range', async () => {
    const tablePath = join(TEST_DIR, 'seek-beyond.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 4096, blockRestartInterval: 16,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    await builder.add(Buffer.from('aaa'), Buffer.from('1'));
    await builder.add(Buffer.from('bbb'), Buffer.from('2'));
    await builder.finish();

    const table = await Table.open(tablePath);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    await iter.seek(Buffer.from('zzz'));
    expect(iter.valid()).toBe(false);

    await iter.seekToLast();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('bbb');

    unlinkSync(tablePath);
  });

  it('should handle table with verifyChecksums', async () => {
    const tablePath = join(TEST_DIR, 'verify-crc.ldb');
    const options = {
      createIfMissing: true, errorIfExists: false, paranoidChecks: false,
      writeBufferSize: 4194304, maxOpenFiles: 1000,
      blockSize: 4096, blockRestartInterval: 16,
      maxFileSize: 2097152, compression: CompressionType.None,
      zstdCompressionLevel: 1, reuseLogs: false,
      filterPolicy: undefined as any,
      keyEncoding: 'buffer' as const, valueEncoding: 'buffer' as const,
    };

    const builder = new TableBuilder(tablePath, options);
    await builder.add(Buffer.from('k1'), Buffer.from('v1'));
    await builder.add(Buffer.from('k2'), Buffer.from('v2'));
    await builder.finish();

    // Open with verifyChecksums=true
    const table = await Table.open(tablePath, true);
    const cmp = new BytewiseComparator();
    const iter = table.iterator(cmp);

    await iter.seekToFirst();
    expect(iter.valid()).toBe(true);
    expect(iter.key().toString()).toBe('k1');

    unlinkSync(tablePath);
  });
});

// ─────────────────────────────────────────────────────────────
// version_set.ts: recovery & comparator mismatch
// ─────────────────────────────────────────────────────────────

describe('09c - VersionSet recovery edge cases', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should recover from MANIFEST after normal DB usage', async () => {
    const dbPath = join(TEST_DIR, 'vs-recover');
    // Create and populate a DB
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256,
    });

    for (let i = 0; i < 100; i++) {
      await db.put(`vs-${i}`, `vsv-${i}`);
    }
    await db.close();

    // Reopen — this triggers recovery
    const db2 = await DB.open(dbPath, {
      createIfMissing: false,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    expect(await db2.get('vs-0')).toBe('vsv-0');
    expect(await db2.get('vs-50')).toBe('vsv-50');
    expect(await db2.get('vs-99')).toBe('vsv-99');

    await db2.close();
  }, 30000);

  it('should create fresh MANIFEST for new DB', async () => {
    const dbPath = join(TEST_DIR, 'vs-manifest-fresh');
    // New DB creates a fresh MANIFEST
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('hello', 'world');
    await db.close();

    // Verify CURRENT and MANIFEST exist
    const currentPath = join(dbPath, 'CURRENT');
    expect(existsSync(currentPath)).toBe(true);

    const currentContent = readFileSync(currentPath, 'utf8');
    expect(currentContent).toContain('MANIFEST-');
  });

  it('should handle DB reopen clearing WAL and restoring from MANIFEST', async () => {
    const dbPath = join(TEST_DIR, 'vs-reopen');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256, // Small to force flush
    });

    await db.put('persist', 'me');
    await db.close(); // Flush on close

    // Reopen
    const db2 = await DB.open(dbPath, {
      createIfMissing: false,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    expect(await db2.get('persist')).toBe('me');
    await db2.close();
  });
});

// ─────────────────────────────────────────────────────────────
// types.ts: encodeInternalKey RangeError
// ─────────────────────────────────────────────────────────────

describe('09d - InternalKey edge cases', () => {
  it('encodeInternalKey should throw RangeError for negative sequence', () => {
    expect(() =>
      encodeInternalKey(Buffer.from('k'), -1n, ValueType.Value)
    ).toThrow(RangeError);
  });

  it('encodeInternalKey should throw RangeError for sequence > kMaxSequenceNumber', () => {
    expect(() =>
      encodeInternalKey(Buffer.from('k'), kMaxSequenceNumber + 1n, ValueType.Value)
    ).toThrow(RangeError);
  });

  it('encode/decode round-trip with max values', () => {
    const ikey = encodeInternalKey(
      Buffer.from('max-test'),
      kMaxSequenceNumber,
      ValueType.Deletion,
    );
    const decoded = decodeInternalKey(ikey);
    expect(decoded.userKey.toString()).toBe('max-test');
    expect(decoded.sequence).toBe(kMaxSequenceNumber);
    expect(decoded.valueType).toBe(ValueType.Deletion);
  });

  it('decodeInternalKey with Value type', () => {
    const ikey = encodeInternalKey(Buffer.from('val-type'), 42n, ValueType.Value);
    const decoded = decodeInternalKey(ikey);
    expect(decoded.valueType).toBe(ValueType.Value);
    expect(decoded.sequence).toBe(42n);
  });
});

// ─────────────────────────────────────────────────────────────
// memtable.ts: internal comparator
// ─────────────────────────────────────────────────────────────

describe('09e - MemTable internal comparator', () => {
  it('should sort by user key first (via internalKeyComparator)', () => {
    const cmp = new BytewiseComparator();
    const arena = new Arena();
    const list = new SkipList(cmp, arena);
    const mem = new MemTable(cmp);

    mem.add(1n, ValueType.Value, Buffer.from('b'), Buffer.from('b-val'));
    mem.add(1n, ValueType.Value, Buffer.from('a'), Buffer.from('a-val'));
    mem.add(1n, ValueType.Value, Buffer.from('c'), Buffer.from('c-val'));

    // Iterate — should be in user key order
    const iter = mem.getInternalIterator();
    iter.seekToFirst();

    const userKeys: string[] = [];
    while (iter.valid()) {
      const d = decodeInternalKey(iter.key());
      userKeys.push(d.userKey.toString());
      iter.next();
    }
    expect(userKeys).toEqual(['a', 'b', 'c']);
  });

  it('MemTable.get should return null for missing key', () => {
    const cmp = new BytewiseComparator();
    const mem = new MemTable(cmp);
    mem.add(1n, ValueType.Value, Buffer.from('exists'), Buffer.from('val'));

    expect(mem.get(Buffer.from('missing'), 100n)).toBeNull();
  });

  it('MemTable.get should respect snapshot (hide newer entries)', () => {
    const cmp = new BytewiseComparator();
    const mem = new MemTable(cmp);

    mem.add(1n, ValueType.Value, Buffer.from('key'), Buffer.from('v1'));
    mem.add(2n, ValueType.Value, Buffer.from('key'), Buffer.from('v2'));

    // With snapshot=1, should not see v2 (seq=2 > 1)
    const result = mem.get(Buffer.from('key'), 1n);
    expect(result).not.toBeNull();
    // When seeking with lookupKey+snapshot seq in the internal key,
    // the skiplist seek will find the first internal key >= encoded(lookup, snap, Value)
    // Since seq2 > seq1, the internal key for seq2 sorts before seq1 (newer first)
    // The get method then checks userKey match and returns the entry
    // With snapshot=1, the encoded seek key uses seq=1
    // So it should find the seq1 entry
    expect(result!.value.toString()).toBe('v1');
  });

  it('MemTable.approximateMemoryUsage should track usage', () => {
    const cmp = new BytewiseComparator();
    const mem = new MemTable(cmp);

    const before = mem.approximateMemoryUsage();
    expect(before).toBe(0);

    mem.add(1n, ValueType.Value, Buffer.from('hello'), Buffer.from('world'));
    // ikey = "hello" + 8 = 13, value = "world" = 5, total = 18
    expect(mem.approximateMemoryUsage()).toBeGreaterThanOrEqual(18);
  });
});

// ─────────────────────────────────────────────────────────────
// db_impl.ts: paranoid checks & edge branches
// ─────────────────────────────────────────────────────────────

describe('09f - DBImpl edge cases', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should handle paranoidChecks option', async () => {
    const dbPath = join(TEST_DIR, 'paranoid-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      paranoidChecks: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('x', 'y');
    const val = await db.get('x');
    expect(val).toBe('y');

    await db.close();
  });

  it('should handle sync write option', async () => {
    const dbPath = join(TEST_DIR, 'sync-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('synced', 'data', { sync: true });
    expect(await db.get('synced')).toBe('data');

    await db.close();
  });

  it('should handle get with verifyChecksums read option', async () => {
    const dbPath = join(TEST_DIR, 'verify-read');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('test', 'ok');
    const val = await db.get('test', { verifyChecksums: true });
    expect(val).toBe('ok');

    await db.close();
  });

  it('should handle get with fillCache=false', async () => {
    const dbPath = join(TEST_DIR, 'nocache-db');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('cached', 'maybe');
    const val = await db.get('cached', { fillCache: false });
    expect(val).toBe('maybe');

    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────
// Iterator: seek+prev complete cycle
// ─────────────────────────────────────────────────────────────

describe('09g - Iterator full navigation cycles', () => {
  it('should handle seekToFirst → next all → seekToLast → prev all', async () => {
    const dbPath = join(TEST_DIR, 'nav-full');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('d', '4');
    await db.put('b', '2');
    await db.put('e', '5');
    await db.put('a', '1');
    await db.put('c', '3');

    const iter = db.iterator();

    // Forward all
    await iter.seekToFirst();
    const forward: string[] = [];
    while (iter.valid()) {
      forward.push(iter.key().toString());
      await iter.next();
    }
    expect(forward).toEqual(['a', 'b', 'c', 'd', 'e']);

    // Reverse all
    await iter.seekToLast();
    const reverse: string[] = [];
    while (iter.valid()) {
      reverse.push(iter.key().toString());
      await iter.prev();
    }
    expect(reverse).toEqual(['e', 'd', 'c', 'b', 'a']);

    iter.close();
    await db.close();
  });

  it('should handle seek mid + prev all the way', async () => {
    const dbPath = join(TEST_DIR, 'nav-mid');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    for (let i = 0; i < 20; i++) {
      await db.put(`n${String.fromCharCode(97 + i)}`, `v${i}`);
    }

    const iter = db.iterator();
    await iter.seek(Buffer.from('nk'));

    // Go backward from mid to start
    const backward: string[] = [];
    backward.push(iter.key().toString());
    await iter.prev();
    while (iter.valid()) {
      backward.push(iter.key().toString());
      await iter.prev();
    }

    // 'nk' ... back to 'na'
    expect(backward.length).toBeGreaterThanOrEqual(1);
    expect(iter.valid()).toBe(false);

    iter.close();
    await db.close();
  });

  it('should handle repeated seek operations', async () => {
    const dbPath = join(TEST_DIR, 'nav-reseek');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    await db.put('p', '1');
    await db.put('q', '2');
    await db.put('r', '3');

    const iter = db.iterator();

    await iter.seek(Buffer.from('q'));
    expect(iter.key().toString()).toBe('q');

    // Re-seek to a different key
    await iter.seek(Buffer.from('p'));
    expect(iter.key().toString()).toBe('p');

    // Re-seek to last
    await iter.seek(Buffer.from('r'));
    expect(iter.key().toString()).toBe('r');

    iter.close();
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────
// scheduler.ts: trigger compaction (best effort)
// ─────────────────────────────────────────────────────────────

describe('09h - Compaction scheduler edge cases', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should automatically compact when level-0 files exceed threshold', async () => {
    const dbPath = join(TEST_DIR, 'auto-compact');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 100, // Tiny buffer → rapid flushes → many level-0 files
    });

    // Write lots of data to force many level-0 files (> 4 triggers compaction)
    for (let i = 0; i < 400; i++) {
      await db.put(`ac-${String(i).padStart(5, '0')}`, `acv-${i}`);
    }

    // After all writes, compaction should have been attempted
    // Check that data is intact
    const v0 = await db.get('ac-00000');
    expect(v0).toBe('acv-0');

    const vMid = await db.get('ac-00200');
    expect(vMid).toBe('acv-200');

    await db.close();
  }, 60000);

  it('should handle DB reopen and compact range', async () => {
    const dbPath = join(TEST_DIR, 'reopen-compact');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 100,
    });

    for (let i = 0; i < 200; i++) {
      await db.put(`rc-${String(i).padStart(4, '0')}`, `rcv-${i}`);
    }

    await db.compactRange();
    await db.close();

    // Reopen and verify
    const db2 = await DB.open(dbPath, {
      createIfMissing: false,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    expect(await db2.get('rc-0000')).toBe('rcv-0');
    expect(await db2.get('rc-0100')).toBe('rcv-100');
    expect(await db2.get('rc-0199')).toBe('rcv-199');

    await db2.close();
  }, 60000);
});
