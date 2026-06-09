/**
 * Whitebox Test 03: Iterator Traversal
 *
 * Covers:
 *   - db.iterator(): seekToFirst, seekToLast, seek, next, prev
 *   - valid(), key(), value(), status(), close()
 *   - Min-heap / max-heap dedup (same key, older versions hidden)
 *   - for await...of (Symbol.asyncIterator)
 *   - AsyncDisposable (using await)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB } from '../../src/index.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '03-iterator');

describe('03 - Iterator Traversal', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── seekToFirst / next (forward traversal) ────────────────

  describe('seekToFirst + next (forward traversal)', () => {
    it('should iterate all keys in sorted order (utf8)', async () => {
      const dbPath = join(TEST_DIR, 'forward-utf8');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Insert in random order
      await db.put('c', '3');
      await db.put('a', '1');
      await db.put('b', '2');
      await db.put('d', '4');

      const iter = db.iterator();
      await iter.seekToFirst();

      const results: { key: string; value: string }[] = [];
      while (iter.valid()) {
        results.push({ key: iter.key().toString(), value: iter.value().toString() });
        await iter.next();
      }

      expect(results).toEqual([
        { key: 'a', value: '1' },
        { key: 'b', value: '2' },
        { key: 'c', value: '3' },
        { key: 'd', value: '4' },
      ]);

      iter.close();
      await db.close();
    });

    it('should return valid()=false for empty database', async () => {
      const dbPath = join(TEST_DIR, 'forward-empty');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const iter = db.iterator();
      await iter.seekToFirst();
      expect(iter.valid()).toBe(false);

      iter.close();
      await db.close();
    });
  });

  // ── seekToLast / prev (reverse traversal) ─────────────────

  describe('seekToLast + prev (reverse traversal)', () => {
    it('should iterate all keys in reverse order', async () => {
      const dbPath = join(TEST_DIR, 'reverse-utf8');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      await db.put('b', '2');
      await db.put('c', '3');

      const iter = db.iterator();
      await iter.seekToLast();

      const results: { key: string; value: string }[] = [];
      while (iter.valid()) {
        results.push({ key: iter.key().toString(), value: iter.value().toString() });
        await iter.prev();
      }

      expect(results).toEqual([
        { key: 'c', value: '3' },
        { key: 'b', value: '2' },
        { key: 'a', value: '1' },
      ]);

      iter.close();
      await db.close();
    });
  });

  // ── seek (position to first key >= target) ────────────────

  describe('seek (first key >= target)', () => {
    it('should seek to exact key', async () => {
      const dbPath = join(TEST_DIR, 'seek-exact');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      await db.put('b', '2');
      await db.put('c', '3');

      const iter = db.iterator();
      await iter.seek(Buffer.from('b'));
      expect(iter.valid()).toBe(true);
      expect(iter.key().toString()).toBe('b');
      expect(iter.value().toString()).toBe('2');

      iter.close();
      await db.close();
    });

    it('should seek to first key >= target when key missing', async () => {
      const dbPath = join(TEST_DIR, 'seek-gte');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      await db.put('c', '3');

      const iter = db.iterator();
      // Seek to 'b' which doesn't exist → should land on 'c' (first >= 'b')
      await iter.seek(Buffer.from('b'));
      expect(iter.valid()).toBe(true);
      expect(iter.key().toString()).toBe('c');

      iter.close();
      await db.close();
    });

    it('should seek beyond last key → valid()=false', async () => {
      const dbPath = join(TEST_DIR, 'seek-beyond');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      await db.put('b', '2');

      const iter = db.iterator();
      await iter.seek(Buffer.from('z'));
      expect(iter.valid()).toBe(false);

      iter.close();
      await db.close();
    });

    it('should seek to first key when target is before all keys', async () => {
      const dbPath = join(TEST_DIR, 'seek-before');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('m', 'mid');
      await db.put('z', 'end');

      const iter = db.iterator();
      await iter.seek(Buffer.from('a'));
      expect(iter.valid()).toBe(true);
      expect(iter.key().toString()).toBe('m');

      iter.close();
      await db.close();
    });
  });

  // ── Min-heap dedup: same key overwritten ─────────────────

  describe('Heap dedup: same key with multiple writes', () => {
    it('should hide older version of same key', async () => {
      const dbPath = join(TEST_DIR, 'dedup-overwrite');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Write same key 3 times
      await db.put('x', 'v1');
      await db.put('x', 'v2');
      await db.put('x', 'v3');

      const iter = db.iterator();
      await iter.seekToFirst();

      const results: { key: string; value: string }[] = [];
      while (iter.valid()) {
        results.push({ key: iter.key().toString(), value: iter.value().toString() });
        await iter.next();
      }

      // Should only see the latest value
      expect(results).toEqual([{ key: 'x', value: 'v3' }]);

      iter.close();
      await db.close();
    });

    it('should hide deleted key after delete', async () => {
      const dbPath = join(TEST_DIR, 'dedup-delete');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('keep', 'yes');
      await db.put('remove', 'soon');
      await db.delete('remove');

      const iter = db.iterator();
      await iter.seekToFirst();

      const results: string[] = [];
      while (iter.valid()) {
        results.push(iter.key().toString());
        await iter.next();
      }

      expect(results).toEqual(['keep']);
      // 'remove' should be hidden

      iter.close();
      await db.close();
    });
  });

  // ── for await...of (Symbol.asyncIterator) ─────────────────

  describe('for await...of (Symbol.asyncIterator)', () => {
    it('should support for await...of syntax', async () => {
      const dbPath = join(TEST_DIR, 'async-iter');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('x', '10');
      await db.put('y', '20');
      await db.put('z', '30');

      const results: { key: string; value: string }[] = [];
      for await (const { key, value } of db.iterator()) {
        results.push({ key: key.toString(), value: value.toString() });
      }

      expect(results).toEqual([
        { key: 'x', value: '10' },
        { key: 'y', value: '20' },
        { key: 'z', value: '30' },
      ]);

      await db.close();
    });
  });

  // ── Iterator status ───────────────────────────────────────

  describe('iterator status()', () => {
    it('should return OK status for healthy iterator', async () => {
      const dbPath = join(TEST_DIR, 'iter-status');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      const iter = db.iterator();
      await iter.seekToFirst();
      expect(iter.status().ok()).toBe(true);

      iter.close();
      await db.close();
    });
  });

  // ── Iterator close / AsyncDisposable ─────────────────────

  describe('iterator close / AsyncDisposable', () => {
    it('should invalidate iterator after close', async () => {
      const dbPath = join(TEST_DIR, 'iter-close');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('a', '1');
      const iter = db.iterator();
      await iter.seekToFirst();
      expect(iter.valid()).toBe(true);

      iter.close();
      expect(iter.valid()).toBe(false);

      await db.close();
    });

    it('should support await using (AsyncDisposable)', async () => {
      const dbPath = join(TEST_DIR, 'iter-async-dispose');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      await db.put('x', 'y');

      // Use block scope for `await using`
      {
        await using iter = db.iterator();
        await iter.seekToFirst();
        expect(iter.valid()).toBe(true);
        // Auto-closed at end of block via Symbol.asyncDispose
      }

      await db.close();
    });
  });
});
