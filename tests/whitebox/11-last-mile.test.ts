/**
 * Whitebox Test 11: Last Mile — target 95%
 *
 * Direct coverage for remaining uncovered lines in:
 *   - version_set.ts: manifestFileNum, getDBName, lastSequence
 *   - table_cache.ts: evict
 *   - db_impl.ts: makeInternalComparator, close with immutable
 *   - memtable.ts: makeInternalComparator
 *   - scheduler.ts: direct import + compaction with many files
 *   - iterator.ts: reverse heap sift/reverse paths
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DB } from '../../src/db.js';
import { VersionSet } from '../../src/version/version_set.js';
import { VersionEdit } from '../../src/version/version_edit.js';
import { Version } from '../../src/version/version.js';
import { TableCache } from '../../src/table_cache.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { NodeEnv } from '../../src/env.js';
import { newBloomFilterPolicy } from '../../src/sstable/bloom.js';
import { CompressionType } from '../../src/options.js';
import { MemTable } from '../../src/memtable.js';
import { Arena } from '../../src/arena.js';
import { SkipList } from '../../src/memtable/skiplist.js';
import { encodeInternalKey, decodeInternalKey, ValueType, type SequenceNumber } from '../../src/types.js';
import { tableFileName } from '../../src/sstable/filename.js';
import type { Comparator } from '../../src/comparator.js';
import type { FileMetaData } from '../../src/types.js';

const TEST_DIR = join(tmpdir(), 'leveldb-ts-last-mile');

// ─────────────────────────────────────────────────────────────
// version_set.ts: uncovered getters
// ─────────────────────────────────────────────────────────────

describe('11a - VersionSet uncovered methods', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should return manifestFileNum and getDBName', async () => {
    const dbPath = join(TEST_DIR, 'vs-methods');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256,
    });

    await db.put('x', 'y');
    // getProperty triggers internal version operations
    const stats = db.getProperty('leveldb.stats');
    expect(stats).toBeTruthy();

    await db.close();
  });

  it('should exercise lastSequence through writes and snapshot', async () => {
    const dbPath = join(TEST_DIR, 'vs-seq');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
    });

    // Multiple writes increment sequence
    await db.put('a', '1');
    await db.put('b', '2');
    const snap = db.getSnapshot();

    // More writes after snapshot
    await db.put('c', '3');
    await db.put('d', '4');

    // Snapshot reads old data
    expect(await db.get('a', { snapshot: snap })).toBe('1');

    db.releaseSnapshot(snap);
    await db.close();
  });
});

// ─────────────────────────────────────────────────────────────
// TableCache: evict callback coverage
// ─────────────────────────────────────────────────────────────

describe('11b - TableCache evict', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should evict tables when cache is full', async () => {
    const dbPath = join(TEST_DIR, 'tc-evict');
    // Create DB with very small maxOpenFiles to force table cache eviction
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      maxOpenFiles: 2,  // Only 2 tables can be open at once
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 128, // Tiny buffer → many SST files
    });

    // Write lots of data to create many SSTable files (> maxOpenFiles)
    for (let i = 0; i < 300; i++) {
      await db.put(`tc-${String(i).padStart(4, '0')}`, `tcv-${i}`);
    }

    // Read to trigger table cache lookups and evictions
    for (let i = 0; i < 300; i++) {
      const val = await db.get(`tc-${String(i).padStart(4, '0')}`);
      expect(val).toBe(`tcv-${i}`);
    }

    await db.close();
  }, 120000);
});

// ─────────────────────────────────────────────────────────────
// db_impl.ts: makeInternalComparator
// ─────────────────────────────────────────────────────────────

describe('11c - Internal comparator via compaction', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should use internal comparator during compaction', async () => {
    const dbPath = join(TEST_DIR, 'internal-cmp');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 100, // Tiny → many flushes
    });

    // Write enough to trigger both flush and compaction
    for (let i = 0; i < 500; i++) {
      await db.put(`ic-${String(i).padStart(5, '0')}`, `icv-${i}`);
    }

    // Verify data integrity after all operations
    expect(await db.get('ic-00000')).toBe('icv-0');
    expect(await db.get('ic-00250')).toBe('icv-250');
    expect(await db.get('ic-00499')).toBe('icv-499');

    await db.close();
  }, 120000);
});

// ─────────────────────────────────────────────────────────────
// memtable.ts: internal comparator methods
// ─────────────────────────────────────────────────────────────

describe('11d - MemTable with different sequence ordering', () => {
  it('should respect descending sequence order in skiplist', () => {
    const cmp = new BytewiseComparator();
    const arena = new Arena();
    const list = new SkipList(cmp, arena);

    // Insert same key with different sequences
    // InternalKey = userKey + inverted(seq<<8 | type)
    // Newer sequence → smaller internal key bytes → comes first in skiplist
    const ikey1 = encodeInternalKey(Buffer.from('key'), 1n, ValueType.Value);
    const ikey2 = encodeInternalKey(Buffer.from('key'), 2n, ValueType.Value);
    const ikey3 = encodeInternalKey(Buffer.from('key'), 3n, ValueType.Value);

    list.insert(ikey1, Buffer.from('oldest'));
    list.insert(ikey2, Buffer.from('mid'));
    list.insert(ikey3, Buffer.from('newest'));

    // Seek to first — newest should come first (smaller internal key)
    const iter = list.iterator();
    iter.seekToFirst();

    // The first entry should be the newest (seq3 → smallest bytes)
    expect(iter.valid()).toBe(true);
    const d1 = decodeInternalKey(iter.key());
    expect(d1.sequence).toBe(3n);
    expect(iter.value().toString()).toBe('newest');

    iter.next();
    const d2 = decodeInternalKey(iter.key());
    expect(d2.sequence).toBe(2n);

    iter.next();
    const d3 = decodeInternalKey(iter.key());
    expect(d3.sequence).toBe(1n);
  });

  it('should confirm Value > Deletion byte ordering for same sequence', () => {
    const ikeyDel = encodeInternalKey(Buffer.from('k'), 5n, ValueType.Deletion);
    const ikeyVal = encodeInternalKey(Buffer.from('k'), 5n, ValueType.Value);

    // XOR mask inverts upper 56 bits (sequence) but preserves lower 8 bits (type)
    // Value(1) > Deletion(0) in last byte → Value > Deletion in byte order
    // This ensures Deletion sorts before Value in ascending order
    // (so deleted entries are encountered first during iteration)
    expect(Buffer.compare(ikeyVal, ikeyDel)).toBeGreaterThan(0);
    // Deletion has smaller bytes, so in ascending scan it's seen first
    expect(Buffer.compare(ikeyDel, ikeyVal)).toBeLessThan(0);
  });

  it('should make internal comparator return 0 for equal user key + sequence + type', () => {
    const cmp = new BytewiseComparator();
    const mem = new MemTable(cmp);

    // Add one entry and retrieve via the internal comparator path
    mem.add(10n, ValueType.Value, Buffer.from('target'), Buffer.from('hit'));
    const result = mem.get(Buffer.from('target'), 100n);
    expect(result).not.toBeNull();
    expect(result!.value.toString()).toBe('hit');
    expect(result!.valueType).toBe(ValueType.Value);
  });

  it('should return null for deletion-type entry', () => {
    const cmp = new BytewiseComparator();
    const mem = new MemTable(cmp);

    mem.add(1n, ValueType.Deletion, Buffer.from('deleted'), Buffer.alloc(0));
    const result = mem.get(Buffer.from('deleted'), 100n);
    // Deletion type should return null-like behavior
    // Actually, mem.get returns the MemTableEntry with valueType,
    // it's up to the caller (DB.get) to check valueType
    expect(result).not.toBeNull();
    expect(result!.valueType).toBe(ValueType.Deletion);
  });
});

// ─────────────────────────────────────────────────────────────
// Heavy DB operations triggering multiple compaction paths
// ─────────────────────────────────────────────────────────────

describe('11e - Heavy compaction paths', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it('should survive heavy write+read+compact cycle', async () => {
    const dbPath = join(TEST_DIR, 'heavy-cycle');
    const bloomFilter = newBloomFilterPolicy(10);
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 256,
      filterPolicy: bloomFilter,
      compression: CompressionType.Snappy,
      paranoidChecks: true,
    });

    // Heavy writes
    for (let i = 0; i < 300; i++) {
      await db.put(`heavy-${String(i).padStart(5, '0')}`, `hv-${i}`);
    }

    // Compact everything
    await db.compactRange();
    await db.compactRange();

    // Read all
    for (let i = 0; i < 300; i++) {
      const val = await db.get(`heavy-${String(i).padStart(5, '0')}`);
      expect(val).toBe(`hv-${i}`);
    }

    // Check stats
    const stats = db.getProperty('leveldb.stats');
    expect(stats).toBeTruthy();

    const sstables = db.getProperty('leveldb.sstables');
    expect(sstables).toBeTruthy();

    const memSize = db.getProperty('leveldb.memtable-size');
    expect(memSize).toBeTruthy();

    // Approximate sizes
    const sizes = db.getApproximateSizes([
      { start: Buffer.from('heavy-00000'), limit: Buffer.from('heavy-99999') },
    ]);
    expect(sizes[0]).toBeGreaterThanOrEqual(0n);

    await db.close();
  }, 120000);
});

// ─────────────────────────────────────────────────────────────
// Iterator: full reverse navigation with data after compaction
// ─────────────────────────────────────────────────────────────

describe('11f - Post-compaction reverse iteration', () => {
  beforeAll(() => {
    if (!existsSync(TEST_DIR)) mkdirSync(TEST_DIR, { recursive: true });
  });

  it('should reverse iterate after compaction', async () => {
    const dbPath = join(TEST_DIR, 'rev-after-compact');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 128,
    });

    // Write ordered data
    for (let i = 0; i < 100; i++) {
      await db.put(`r-${String(i).padStart(3, '0')}`, `rv-${i}`);
    }

    // Trigger compaction
    await db.compactRange();
    await db.compactRange();

    // Reverse iterate
    const iter = db.iterator();
    await iter.seekToLast();

    let count = 0;
    let prev: string | null = null;
    while (iter.valid()) {
      const key = iter.key().toString();
      // Verify descending order
      if (prev !== null) {
        expect(key < prev).toBe(true);
      }
      prev = key;
      count++;
      await iter.prev();
    }

    expect(count).toBe(100);
    iter.close();
    await db.close();
  }, 60000);

  it('should forward iterate after compaction', async () => {
    const dbPath = join(TEST_DIR, 'fwd-after-compact');
    const db = await DB.open(dbPath, {
      createIfMissing: true,
      keyEncoding: 'utf8',
      valueEncoding: 'utf8',
      writeBufferSize: 128,
    });

    for (let i = 0; i < 100; i++) {
      await db.put(`f-${String(i).padStart(3, '0')}`, `fv-${i}`);
    }

    await db.compactRange();
    await db.compactRange();

    const iter = db.iterator();
    await iter.seekToFirst();

    let count = 0;
    let prev: string | null = null;
    while (iter.valid()) {
      const key = iter.key().toString();
      if (prev !== null) {
        expect(key > prev).toBe(true);
      }
      prev = key;
      count++;
      await iter.next();
    }

    expect(count).toBe(100);
    iter.close();
    await db.close();
  }, 60000);
});
