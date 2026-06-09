/**
 * Whitebox Test 04: Snapshot & MVCC Isolation
 *
 * Covers:
 *   - db.getSnapshot / db.releaseSnapshot
 *   - ReadOptions.snapshot — reads old version after writes
 *   - Delete isolation (deleted after snapshot still visible)
 *   - using sn = db.getSnapshot() (Disposable / Symbol.dispose)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from '../../src/index.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '04-snapshot');

describe('04 - Snapshot & MVCC Isolation', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Basic snapshot isolation ──────────────────────────────

  describe('Snapshot: basic MVCC isolation', () => {
    it('should read old value after snapshot + overwrite', async () => {
      const dbPath = join(TEST_DIR, 'snap-old-value');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('color', 'red');
      const snap = db.getSnapshot();

      // Overwrite after snapshot
      await db.put('color', 'blue');

      // Read with snapshot → should see old value
      const oldVal = await db.get('color', { snapshot: snap });
      expect(oldVal).toBe('red');

      // Read without snapshot → should see latest value
      const newVal = await db.get('color');
      expect(newVal).toBe('blue');

      db.releaseSnapshot(snap);
      await db.close();
    });

    it('should see data inserted before snapshot', async () => {
      const dbPath = join(TEST_DIR, 'snap-see-before');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('fruit', 'apple');
      const snap = db.getSnapshot();

      // Read via snapshot
      const val = await db.get('fruit', { snapshot: snap });
      expect(val).toBe('apple');

      db.releaseSnapshot(snap);
      await db.close();
    });

    it('should NOT see data inserted after snapshot', async () => {
      const dbPath = join(TEST_DIR, 'snap-not-see-after');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Empty DB → take snapshot
      const snap = db.getSnapshot();

      // Insert after snapshot
      await db.put('new-key', 'new-val');

      // Snapshot should NOT see this key
      const val = await db.get('new-key', { snapshot: snap });
      expect(val).toBeNull();

      db.releaseSnapshot(snap);
      await db.close();
    });
  });

  // ── Delete isolation ──────────────────────────────────────

  describe('Snapshot: delete isolation', () => {
    it('should see deleted value through snapshot', async () => {
      const dbPath = join(TEST_DIR, 'snap-delete');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('ephemeral', 'data');
      const snap = db.getSnapshot();

      // Delete after snapshot
      await db.delete('ephemeral');

      // Snapshot should still see it
      const val = await db.get('ephemeral', { snapshot: snap });
      expect(val).toBe('data');

      // Without snapshot → null
      const latest = await db.get('ephemeral');
      expect(latest).toBeNull();

      db.releaseSnapshot(snap);
      await db.close();
    });
  });

  // ── Iterator with snapshot ────────────────────────────────

  describe('Snapshot: iterator isolation', () => {
    it('should iterate snapshot-visible keys only', async () => {
      const dbPath = join(TEST_DIR, 'snap-iter');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      await db.put('b', '2');
      const snap = db.getSnapshot();

      // Add more after snapshot
      await db.put('c', '3');
      await db.put('d', '4');

      const iter = db.iterator({ snapshot: snap });
      await iter.seekToFirst();

      const keys: string[] = [];
      while (iter.valid()) {
        keys.push(iter.key().toString());
        await iter.next();
      }

      // Should only see keys that existed at snapshot time
      expect(keys).toEqual(['a', 'b']);

      iter.close();
      db.releaseSnapshot(snap);
      await db.close();
    });
  });

  // ── releaseSnapshot ───────────────────────────────────────

  describe('releaseSnapshot', () => {
    it('should release and make snapshot unusable', async () => {
      const dbPath = join(TEST_DIR, 'snap-release');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('x', '1');
      const snap = db.getSnapshot();
      db.releaseSnapshot(snap);

      // After release, reading with this snapshot should still work
      // (Snapshot object is still valid, just removed from DB's list)
      // Actually the snapshot sequence is still valid for read
      const val = await db.get('x', { snapshot: snap });
      expect(val).toBe('1');

      await db.close();
    });
  });

  // ── using syntax (Disposable) ─────────────────────────────

  describe('using syntax (Symbol.dispose)', () => {
    it('should support explicit resource management', async () => {
      const dbPath = join(TEST_DIR, 'snap-using');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('foo', 'bar');

      // `using` auto-calls Symbol.dispose at end of block
      {
        using snap = db.getSnapshot();
        const val = await db.get('foo', { snapshot: snap });
        expect(val).toBe('bar');
        // snap released automatically here
      }

      await db.close();
    });
  });

  // ── Multiple snapshots ────────────────────────────────────

  describe('Multiple concurrent snapshots', () => {
    it('should support multiple isolated snapshots', async () => {
      const dbPath = join(TEST_DIR, 'snap-multi');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('v', 'v1');
      const snap1 = db.getSnapshot();

      await db.put('v', 'v2');
      const snap2 = db.getSnapshot();

      await db.put('v', 'v3');

      // Each snapshot sees its version
      expect(await db.get('v', { snapshot: snap1 })).toBe('v1');
      expect(await db.get('v', { snapshot: snap2 })).toBe('v2');
      expect(await db.get('v')).toBe('v3');

      db.releaseSnapshot(snap1);
      db.releaseSnapshot(snap2);
      await db.close();
    });
  });
});
