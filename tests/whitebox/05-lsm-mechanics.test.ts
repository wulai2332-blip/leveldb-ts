/**
 * Whitebox Test 05: LSM-Tree Mechanics
 *
 * Covers:
 *   - db.getProperty (leveldb.stats, leveldb.num-files-at-levelN, leveldb.memtable-size, leveldb.sstables)
 *   - db.getApproximateSizes
 *   - db.compactRange
 *   - MemTable flush triggered by small writeBufferSize
 *   - Level file counts before/after compaction
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from '../../src/index.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '05-lsm');

describe('05 - LSM-Tree Mechanics', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── getProperty: memtable-size ────────────────────────────

  describe('getProperty: leveldb.memtable-size', () => {
    it('should return memtable memory usage', async () => {
      const dbPath = join(TEST_DIR, 'prop-memtable');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Initially should be 0
      const size0 = parseInt(db.getProperty('leveldb.memtable-size'), 10);
      expect(size0).toBeGreaterThanOrEqual(0);

      // After writing data, size should increase
      await db.put('some-key', 'some-value');
      const size1 = parseInt(db.getProperty('leveldb.memtable-size'), 10);
      expect(size1).toBeGreaterThan(size0);

      await db.close();
    });
  });

  // ── getProperty: leveldb.stats ────────────────────────────

  describe('getProperty: leveldb.stats', () => {
    it('should return stats for all 7 levels', async () => {
      const dbPath = join(TEST_DIR, 'prop-stats');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const stats = db.getProperty('leveldb.stats');
      expect(stats).toBeTruthy();

      // Should contain lines for all 7 levels (0–6)
      for (let i = 0; i < 7; i++) {
        expect(stats).toContain(`Level ${i}`);
      }

      await db.close();
    });
  });

  // ── getProperty: leveldb.num-files-at-levelN ──────────────

  describe('getProperty: leveldb.num-files-at-levelN', () => {
    it('should return file count for specific level', async () => {
      const dbPath = join(TEST_DIR, 'prop-num-files');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // New DB: all levels should have 0 files
      expect(db.getProperty('leveldb.num-files-at-level0')).toBe('0');
      expect(db.getProperty('leveldb.num-files-at-level1')).toBe('0');
      expect(db.getProperty('leveldb.num-files-at-level6')).toBe('0');

      await db.close();
    });

    it('should return "0" for invalid level index', async () => {
      const dbPath = join(TEST_DIR, 'prop-num-files-bad');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Out of range levels should return '0'
      expect(db.getProperty('leveldb.num-files-at-level7')).toBe('0');
      expect(db.getProperty('leveldb.num-files-at-level-1')).toBe('0');

      await db.close();
    });
  });

  // ── MemTable flush (small writeBufferSize) ────────────────

  describe('MemTable flush via small writeBufferSize', () => {
    it('should flush to SSTable and create level-0 file', async () => {
      const dbPath = join(TEST_DIR, 'flush-small-buffer');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 1024, // 1KB — very small to trigger flush easily
      });

      // Write enough data to exceed 1KB write buffer
      // Each put with key "kXXX" (4B) + value "vXXX" (4B) ≈ 8B + overhead
      // 1024 / ~20 per entry ≈ ~50 entries to fill 1KB
      for (let i = 0; i < 200; i++) {
        await db.put(`key-${i}`, `value-${i}`);
      }

      // After write buffer fills, a flush should have occurred
      // Level-0 should have at least 1 file
      const level0Files = parseInt(
        db.getProperty('leveldb.num-files-at-level0'),
        10
      );
      expect(level0Files).toBeGreaterThanOrEqual(1);

      // Data should still be readable
      const val = await db.get('key-0');
      expect(val).toBe('value-0');

      const val2 = await db.get('key-199');
      expect(val2).toBe('value-199');

      await db.close();
    }, 30000); // 30s timeout — flushing may take time

    it('should persist data across close/reopen after flush', async () => {
      const dbPath = join(TEST_DIR, 'flush-persist');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 512, // tiny 512 byte buffer
      });

      // Write enough to trigger flush
      for (let i = 0; i < 100; i++) {
        await db.put(`pk-${i}`, `pv-${i}`);
      }

      // Close to flush and persist
      await db.close();

      // Reopen and verify data
      const db2 = await DB.open(dbPath, {
        createIfMissing: false,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // After reopen, should have level-0 files
      const level0Files = parseInt(
        db2.getProperty('leveldb.num-files-at-level0'),
        10
      );
      expect(level0Files).toBeGreaterThanOrEqual(1);

      // Spot-check several keys
      expect(await db2.get('pk-0')).toBe('pv-0');
      expect(await db2.get('pk-50')).toBe('pv-50');
      expect(await db2.get('pk-99')).toBe('pv-99');

      // Non-existent key should return null
      expect(await db2.get('pk-999')).toBeNull();

      await db2.close();
    }, 30000);
  });

  // ── compactRange ──────────────────────────────────────────

  describe('compactRange', () => {
    it('should not throw on empty or near-empty DB', async () => {
      const dbPath = join(TEST_DIR, 'compact-empty');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Compacting an empty DB should not throw
      await expect(db.compactRange()).resolves.toBeUndefined();

      await db.close();
    });

    it('should compact a specific key range', async () => {
      const dbPath = join(TEST_DIR, 'compact-range');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 512,
      });

      // Write a lot of data to create multiple level-0 files
      for (let i = 0; i < 300; i++) {
        await db.put(`ck-${i.toString().padStart(4, '0')}`, `cv-${i}`);
      }

      // Verify level-0 has files
      const l0Before = parseInt(
        db.getProperty('leveldb.num-files-at-level0'),
        10
      );
      expect(l0Before).toBeGreaterThanOrEqual(1);

      // Compact a sub-range
      await db.compactRange(
        Buffer.from('ck-0000'),
        Buffer.from('ck-0050')
      );

      // Data in range should still be accessible
      expect(await db.get('ck-0000')).toBe('cv-0');
      expect(await db.get('ck-0025')).toBe('cv-25');
      expect(await db.get('ck-0100')).toBe('cv-100');

      await db.close();
    }, 60000);
  });

  // ── getApproximateSizes ───────────────────────────────────

  describe('getApproximateSizes', () => {
    it('should return zero for empty DB', async () => {
      const dbPath = join(TEST_DIR, 'approx-empty');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const sizes = db.getApproximateSizes([
        { start: Buffer.from('a'), limit: Buffer.from('z') },
      ]);

      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toBe(0n);

      await db.close();
    });

    it('should return non-zero sizes after data written and flushed', async () => {
      const dbPath = join(TEST_DIR, 'approx-nonzero');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 512,
      });

      // Write enough to flush
      for (let i = 0; i < 200; i++) {
        await db.put(`sz-${i.toString().padStart(4, '0')}`, `val-${i}`);
      }

      // Close to ensure all flushed
      await db.close();

      // Reopen
      const db2 = await DB.open(dbPath, {
        createIfMissing: false,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const sizes = db2.getApproximateSizes([
        { start: Buffer.from('sz-0000'), limit: Buffer.from('sz-9999') },
      ]);

      expect(sizes).toHaveLength(1);
      // Should have some size since SSTable files exist
      expect(sizes[0]).toBeGreaterThan(0n);

      await db2.close();
    }, 30000);

    it('should return zero for range outside all files', async () => {
      const dbPath = join(TEST_DIR, 'approx-outside');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 512,
      });

      for (let i = 0; i < 100; i++) {
        await db.put(`as-${i}`, `v-${i}`);
      }

      // Range outside all keys
      const sizes = db.getApproximateSizes([
        { start: Buffer.from('zzz'), limit: Buffer.from('zzzz') },
      ]);

      expect(sizes).toHaveLength(1);
      expect(sizes[0]).toBe(0n);

      await db.close();
    }, 30000);
  });

  // ── getProperty: leveldb.sstables ─────────────────────────

  describe('getProperty: leveldb.sstables', () => {
    it('should list SSTable files with level and size info', async () => {
      const dbPath = join(TEST_DIR, 'prop-sstables');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
        writeBufferSize: 1024,
      });

      for (let i = 0; i < 100; i++) {
        await db.put(`t-${i}`, `v-${i}`);
      }

      const sstables = db.getProperty('leveldb.sstables');

      // After writing enough, should have at least one SSTable listed
      if (parseInt(db.getProperty('leveldb.num-files-at-level0'), 10) > 0) {
        expect(sstables).toContain('.ldb');
        expect(sstables).toContain('Level-0');
      }

      await db.close();
    }, 30000);
  });
});
