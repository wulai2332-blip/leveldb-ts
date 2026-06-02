/**
 * VersionSet 独立单元测试 (补盲区 #6)
 * 测试 MANIFEST 恢复、CURRENT 文件处理、logAndApply 边界情况
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { VersionSet } from '../../src/version/version_set.js';
import { VersionEdit } from '../../src/version/version_edit.js';
import { BytewiseComparator } from '../../src/comparator.js';
import { NodeEnv } from '../../src/env.js';
import { defaultDBOptions } from '../../src/options.js';
import type { Comparator } from '../../src/comparator.js';

describe('VersionSet Standalone', () => {
  let dbdir: string;
  let cmp: Comparator;
  let env: NodeEnv;
  let opts: ReturnType<typeof defaultDBOptions>;

  beforeEach(() => {
    dbdir = join(tmpdir(), `vs-test-${randomBytes(4).toString('hex')}`);
    cmp = new BytewiseComparator();
    env = new NodeEnv();
    opts = defaultDBOptions();
  });

  afterEach(() => {
    try { rmSync(dbdir, { recursive: true, force: true }); } catch {}
  });

  // ─── 初始化测试 ───
  describe('Initialization', () => {
    it('should create new database with MANIFEST and CURRENT', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      expect(existsSync(dbdir)).toBe(true);
      const currentPath = join(dbdir, 'CURRENT');
      expect(existsSync(currentPath)).toBe(true);
      const currentContent = readFileSync(currentPath, 'utf8');
      expect(currentContent).toContain('MANIFEST-');
    });

    it('should throw if database does not exist and createIfMissing=false', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await expect(vs.initialize(false)).rejects.toThrow('does not exist');
    });

    it('should recover from existing MANIFEST', async () => {
      // Create initial
      const vs1 = new VersionSet(dbdir, opts, cmp, env);
      await vs1.initialize(true);

      // Add a file via logAndApply
      const edit = vs1.newVersionEdit();
      edit.addFile(0, {
        fileNumber: 42,
        fileSize: 1024,
        smallest: Buffer.from('a'),
        largest: Buffer.from('z'),
      });
      await vs1.logAndApply(edit);

      // Re-open and recover
      const vs2 = new VersionSet(dbdir, opts, cmp, env);
      await vs2.initialize(false);
      const current = vs2.current();
      expect(current.files(0).length).toBe(1);
      expect(current.files(0)[0].fileNumber).toBe(42);
    });
  });

  // ─── 文件编号管理 ───
  describe('File Number Allocation', () => {
    it('should allocate monotonically increasing file numbers', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const n1 = vs.allocateFileNumber();
      const n2 = vs.allocateFileNumber();
      const n3 = vs.allocateFileNumber();

      expect(n1).toBeLessThan(n2);
      expect(n2).toBeLessThan(n3);
    });
  });

  // ─── VersionEdit 应用 ───
  describe('logAndApply', () => {
    it('should apply added files to current version', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const edit = vs.newVersionEdit();
      edit.addFile(0, {
        fileNumber: 100,
        fileSize: 500,
        smallest: Buffer.from('apple'),
        largest: Buffer.from('banana'),
      });
      edit.addFile(1, {
        fileNumber: 200,
        fileSize: 1000,
        smallest: Buffer.from('cherry'),
        largest: Buffer.from('date'),
      });
      await vs.logAndApply(edit);

      const cur = vs.current();
      expect(cur.files(0).length).toBe(1);
      expect(cur.files(1).length).toBe(1);
      expect(cur.files(0)[0].fileNumber).toBe(100);
      expect(cur.files(1)[0].fileNumber).toBe(200);
    });

    it('should apply deleted files to current version', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      // Add a file first
      const addEdit = vs.newVersionEdit();
      addEdit.addFile(0, {
        fileNumber: 300,
        fileSize: 200,
        smallest: Buffer.from('x'),
        largest: Buffer.from('y'),
      });
      await vs.logAndApply(addEdit);

      // Now delete it
      const delEdit = vs.newVersionEdit();
      delEdit.deleteFile(0, 300);
      await vs.logAndApply(delEdit);

      expect(vs.current().files(0).length).toBe(0);
    });

    it('should update sequence number via edit', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const edit = vs.newVersionEdit();
      edit.setLastSequence(999n);
      await vs.logAndApply(edit);

      expect(vs.lastSequence()).toBe(999n);
    });

    it('should update nextFileNumber via edit', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const edit = vs.newVersionEdit();
      edit.setNextFile(500);
      await vs.logAndApply(edit);

      // nextFileNumber should be at least 500
      const fn = vs.allocateFileNumber();
      expect(fn).toBeGreaterThanOrEqual(500);
    });
  });

  // ─── Comparator 不匹配检测 ───
  describe('Comparator Mismatch Detection', () => {
    it('should throw on comparator mismatch during recovery', async () => {
      // Create with one comparator
      const vs1 = new VersionSet(dbdir, opts, cmp, env);
      await vs1.initialize(true);

      // Try to recover with a different comparator name
      const badCmp: Comparator = {
        name: () => 'different.comparator.Name',
        compare: cmp.compare,
        findShortestSeparator: cmp.findShortestSeparator,
        findShortSuccessor: cmp.findShortSuccessor,
      };
      const vs2 = new VersionSet(dbdir, opts, badCmp, env);
      await expect(vs2.initialize(false)).rejects.toThrow('Comparator mismatch');
    });
  });

  // ─── Snapshot/Sequence 管理 ───
  describe('Sequence Number Management', () => {
    it('should track last sequence', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      expect(vs.lastSequence()).toBe(0n);

      vs.setLastSequence(42n);
      expect(vs.lastSequence()).toBe(42n);
    });

    it('should recover sequence from MANIFEST', async () => {
      const vs1 = new VersionSet(dbdir, opts, cmp, env);
      await vs1.initialize(true);

      const edit = vs1.newVersionEdit();
      edit.setLastSequence(777n);
      await vs1.logAndApply(edit);

      const vs2 = new VersionSet(dbdir, opts, cmp, env);
      await vs2.initialize(false);
      expect(vs2.lastSequence()).toBe(777n);
    });
  });

  // ─── 边界情况 ───
  describe('Edge Cases', () => {
    it('should handle logAndApply with empty edit', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const edit = vs.newVersionEdit();
      await vs.logAndApply(edit);
      // Should not throw
    });

    it('should handle multiple logAndApply calls', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      for (let i = 0; i < 10; i++) {
        const edit = vs.newVersionEdit();
        edit.addFile(0, {
          fileNumber: i,
          fileSize: 100,
          smallest: Buffer.from(`key${i}`),
          largest: Buffer.from(`key${i}`),
        });
        await vs.logAndApply(edit);
      }

      expect(vs.current().files(0).length).toBe(10);
    });

    it('should handle file deletion of non-existent file gracefully', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);

      const edit = vs.newVersionEdit();
      edit.deleteFile(0, 99999); // non-existent file
      await vs.logAndApply(edit);
      // Should not throw
    });

    it('should return dbName', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);
      expect(vs.getDBName()).toBe(dbdir);
    });

    it('should return manifest file number', async () => {
      const vs = new VersionSet(dbdir, opts, cmp, env);
      await vs.initialize(true);
      expect(vs.manifestFileNum()).toBeGreaterThan(0);
    });
  });

  // ─── 恢复完整性 ───
  describe('Recovery Integrity', () => {
    it('should recover multiple edits in order', async () => {
      const vs1 = new VersionSet(dbdir, opts, cmp, env);
      await vs1.initialize(true);

      // Apply several edits
      for (let i = 0; i < 5; i++) {
        const edit = vs1.newVersionEdit();
        edit.addFile(i % 7, {
          fileNumber: 100 + i,
          fileSize: 100 * (i + 1),
          smallest: Buffer.from(`a${i}`),
          largest: Buffer.from(`z${i}`),
        });
        await vs1.logAndApply(edit);
      }

      // Recover
      const vs2 = new VersionSet(dbdir, opts, cmp, env);
      await vs2.initialize(false);

      const cur = vs2.current();
      let totalFiles = 0;
      for (let level = 0; level < 7; level++) {
        totalFiles += cur.files(level).length;
      }
      expect(totalFiles).toBe(5);
    });
  });
});
