/**
 * Whitebox Test 02: WriteBatch Atomicity
 *
 * Covers:
 *   - WriteBatch.put / .delete / .clear / .approxSize
 *   - WriteBatch.iterate / .append
 *   - WriteBatch.encode() / WriteBatch.decode() round-trip
 *   - db.write(batch) atomic application
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { DB, WriteBatch } from '../../src/index.js';
import { ValueType } from '../../src/types.js';

const TEST_DIR = join(import.meta.dirname ?? __dirname, '..', '..', '.test-tmp', '02-batch');

describe('02 - WriteBatch Atomicity', () => {
  beforeAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterAll(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Basic batch operations ────────────────────────────────

  describe('WriteBatch: put / delete / clear', () => {
    it('should apply multiple puts atomically via db.write', async () => {
      const dbPath = join(TEST_DIR, 'batch-put-multi');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      const batch = new WriteBatch();
      batch.put(Buffer.from('k1'), Buffer.from('v1'));
      batch.put(Buffer.from('k2'), Buffer.from('v2'));
      batch.put(Buffer.from('k3'), Buffer.from('v3'));
      await db.write(batch);

      expect(await db.get('k1')).toBe('v1');
      expect(await db.get('k2')).toBe('v2');
      expect(await db.get('k3')).toBe('v3');

      await db.close();
    });

    it('should apply mixed put + delete atomically', async () => {
      const dbPath = join(TEST_DIR, 'batch-mixed');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Pre-populate
      await db.put('a', '1');
      await db.put('b', '2');
      await db.put('c', '3');

      // Batch: update 'a', delete 'b', add 'd'
      const batch = new WriteBatch();
      batch.put(Buffer.from('a'), Buffer.from('updated'));
      batch.delete(Buffer.from('b'));
      batch.put(Buffer.from('d'), Buffer.from('new'));
      await db.write(batch);

      expect(await db.get('a')).toBe('updated');
      expect(await db.get('b')).toBeNull();
      expect(await db.get('c')).toBe('3');
      expect(await db.get('d')).toBe('new');

      await db.close();
    });

    it('should clear all entries', () => {
      const batch = new WriteBatch();
      batch.put(Buffer.from('x'), Buffer.from('y'));
      batch.put(Buffer.from('z'), Buffer.from('w'));
      expect(batch.approxSize()).toBeGreaterThan(0);

      batch.clear();
      expect(batch.approxSize()).toBe(0);
    });
  });

  // ── approxSize ────────────────────────────────────────────

  describe('WriteBatch: approxSize', () => {
    it('should return 0 for empty batch', () => {
      const batch = new WriteBatch();
      expect(batch.approxSize()).toBe(0);
    });

    it('should increase approx size with each put', () => {
      const batch = new WriteBatch();
      const s0 = batch.approxSize();

      batch.put(Buffer.from('hello'), Buffer.from('world'));
      // approxSize = key_len + value_len + 1 (type byte)
      // "hello" = 5, "world" = 5 => 5 + 5 + 1 = 11
      expect(batch.approxSize() - s0).toBe(11);

      batch.put(Buffer.from('foo'), Buffer.from('bar'));
      // "foo" = 3, "bar" = 3 => +3+3+1 = +7, total +18 from start
      expect(batch.approxSize() - s0).toBe(18);
    });

    it('should increase approx size with each delete (no value)', () => {
      const batch = new WriteBatch();
      batch.delete(Buffer.from('key-to-delete'));
      // "key-to-delete" = 13 chars, +1 for type byte = 14
      expect(batch.approxSize()).toBe(14);
    });
  });

  // ── iterate ───────────────────────────────────────────────

  describe('WriteBatch: iterate', () => {
    it('should iterate over all entries in order', () => {
      const batch = new WriteBatch();
      batch.put(Buffer.from('k1'), Buffer.from('v1'));
      batch.delete(Buffer.from('k2'));
      batch.put(Buffer.from('k3'), Buffer.from('v3'));

      const entries: { key: string; value: string; type: number }[] = [];
      batch.iterate((key, value, type) => {
        entries.push({
          key: key.toString(),
          value: value.toString(),
          type,
        });
      });

      expect(entries).toHaveLength(3);
      expect(entries[0]).toEqual({ key: 'k1', value: 'v1', type: ValueType.Value });
      expect(entries[1]).toEqual({ key: 'k2', value: '', type: ValueType.Deletion });
      expect(entries[2]).toEqual({ key: 'k3', value: 'v3', type: ValueType.Value });
    });

    it('should not iterate over empty batch', () => {
      const batch = new WriteBatch();
      const entries: unknown[] = [];
      batch.iterate(() => entries.push(1));
      expect(entries).toHaveLength(0);
    });
  });

  // ── append ────────────────────────────────────────────────

  describe('WriteBatch: append', () => {
    it('should merge entries from another batch', () => {
      const batch1 = new WriteBatch();
      batch1.put(Buffer.from('a'), Buffer.from('1'));

      const batch2 = new WriteBatch();
      batch2.put(Buffer.from('b'), Buffer.from('2'));
      batch2.delete(Buffer.from('c'));

      batch1.append(batch2);
      expect(batch1.approxSize()).toBeGreaterThan(0);

      // Verify entries combined
      const entries: string[] = [];
      batch1.iterate((key) => entries.push(key.toString()));
      expect(entries).toEqual(['a', 'b', 'c']);
    });

    it('should copy data (not share references)', () => {
      const batch1 = new WriteBatch();
      batch1.put(Buffer.from('x'), Buffer.from('old'));

      const batch2 = new WriteBatch();
      batch1.append(batch2);

      // Modify original should not affect appended
      batch2.put(Buffer.from('y'), Buffer.from('new'));

      const entries: string[] = [];
      batch1.iterate((key) => entries.push(key.toString()));
      // batch1 should still only have 'x' since batch2 was empty when appended
      expect(entries).toEqual(['x']);
    });
  });

  // ── encode / decode round-trip ────────────────────────────

  describe('WriteBatch: encode / decode round-trip', () => {
    it('should encode and decode preserving all entries', () => {
      const original = new WriteBatch();
      original.put(Buffer.from('key1'), Buffer.from('val1'));
      original.delete(Buffer.from('key2'));
      original.put(Buffer.from('key3'), Buffer.from('val3'));

      const encoded = original.encode();
      const decoded = WriteBatch.decode(encoded);

      const origEntries: { key: string; value: string; type: number }[] = [];
      const decEntries: { key: string; value: string; type: number }[] = [];

      original.iterate((k, v, t) =>
        origEntries.push({ key: k.toString(), value: v.toString(), type: t })
      );
      decoded.iterate((k, v, t) =>
        decEntries.push({ key: k.toString(), value: v.toString(), type: t })
      );

      expect(decEntries).toEqual(origEntries);
    });

    it('should handle empty batch encode/decode', () => {
      const original = new WriteBatch();
      const encoded = original.encode();
      const decoded = WriteBatch.decode(encoded);

      const entries: unknown[] = [];
      decoded.iterate(() => entries.push(1));
      expect(entries).toHaveLength(0);
    });

    it('should encode with correct wire format header (8B seq + 4B count)', () => {
      const batch = new WriteBatch();
      batch.put(Buffer.from('k'), Buffer.from('v'));
      batch.delete(Buffer.from('d'));

      const encoded = batch.encode();
      // First 8 bytes: sequence (should be 0 for unapplied batch)
      // Next 4 bytes: count (2 entries)
      expect(encoded.length).toBeGreaterThanOrEqual(12);
      const count = encoded.readUInt32LE(8);
      expect(count).toBe(2);
    });

    it('should handle binary keys and values in encode/decode', () => {
      const original = new WriteBatch();
      const binKey = Buffer.from([0x00, 0xff, 0x01, 0xfe]);
      const binVal = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      original.put(binKey, binVal);
      original.delete(Buffer.from([0x99]));

      const encoded = original.encode();
      const decoded = WriteBatch.decode(encoded);

      const entries: { key: Buffer; value: Buffer; type: number }[] = [];
      decoded.iterate((k, v, t) => entries.push({ key: k, value: v, type: t }));

      expect(entries).toHaveLength(2);
      expect(entries[0].key).toEqual(binKey);
      expect(entries[0].value).toEqual(binVal);
      expect(entries[0].type).toBe(ValueType.Value);
      expect(entries[1].key).toEqual(Buffer.from([0x99]));
      expect(entries[1].type).toBe(ValueType.Deletion);
    });
  });

  // ── Atomicity via db.write ────────────────────────────────

  describe('db.write: atomic batch application', () => {
    it('should apply put and delete in one batch preserving data consistency', async () => {
      const dbPath = join(TEST_DIR, 'atomic-batch-db');
      const db = await DB.open(dbPath, {
        createIfMissing: true,
        keyEncoding: 'utf8',
        valueEncoding: 'utf8',
      });

      // Seed data
      await db.put('keep', 'yes');
      await db.put('remove', 'soon');

      // Batch: keep updated + remove deleted + new added
      const batch = new WriteBatch();
      batch.put(Buffer.from('keep'), Buffer.from('still-yes'));
      batch.delete(Buffer.from('remove'));
      batch.put(Buffer.from('newbie'), Buffer.from('hello'));
      await db.write(batch);

      expect(await db.get('keep')).toBe('still-yes');
      expect(await db.get('remove')).toBeNull();
      expect(await db.get('newbie')).toBe('hello');

      await db.close();
    });
  });
});
