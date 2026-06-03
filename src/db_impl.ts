import { existsSync, unlinkSync, statSync, readdirSync, rmdirSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { DB } from './db.js';
import { MemTable } from './memtable.js';
import { LogWriter } from './wal/writer.js';
import { LogReader } from './wal/reader.js';
import { VersionSet } from './version/version_set.js';
import { VersionEdit } from './version/version_edit.js';
import { BytewiseComparator } from './comparator.js';
import type { Comparator } from './comparator.js';
import { NodeEnv } from './env.js';
import { Snapshot } from './snapshot.js';
import { WriteBatch } from './write_batch.js';
import { Iterator, type IterLike } from './iterator.js';
import { TableCache } from './table_cache.js';
import { TableBuilder } from './sstable/table_builder.js';
import { CompactionScheduler } from './compaction/scheduler.js';
import { tableFileName, logFileName } from './sstable/filename.js';
import { decodeInternalKey, encodeInternalKey, ValueType, type SequenceNumber, type FileMetaData, type Range } from './types.js';
import { defaultDBOptions, defaultReadOptions, defaultWriteOptions, type DBOptions, type ReadOptions, type WriteOptions } from './options.js';
import { encodeUserKey, decodeUserKey, encodeUserValue, decodeUserValue } from './codec.js';
import { CorruptionError, IOError } from './error.js';

export class DBImpl extends DB {
  private mem!: MemTable;
  private immutableMem: MemTable | null = null;
  private log!: LogWriter;
  private logNumber = 0;
  private versions!: VersionSet;
  private cmp: Comparator = new BytewiseComparator();
  private env = new NodeEnv();
  private options!: Required<DBOptions>;
  private dbname = '';
  private seq: SequenceNumber = 1n;
  private snapshots: Snapshot[] = [];
  private closed = false;
  private tableCache!: TableCache;
  private compactionScheduler!: CompactionScheduler;
  private compactionWorker: Worker | null = null;
  private writeLock: Promise<void> = Promise.resolve(); // write serialization lock

  private constructor() {
    super();
  }

  static async open(name: string, options: DBOptions): Promise<DBImpl> {
    const db = new DBImpl();
    db.dbname = name;
    db.options = { ...defaultDBOptions(), ...options } as Required<DBOptions>;

    if (!existsSync(name)) {
      if (!db.options.createIfMissing) {
        throw new Error(`Database ${name} does not exist`);
      }
    } else if (db.options.errorIfExists) {
      throw new Error(`Database ${name} already exists`);
    }

    // Initialize VersionSet (handles create/recover)
    db.versions = new VersionSet(name, db.options, db.cmp, db.env);
    await db.versions.initialize(db.options.createIfMissing);

    // Initialize TableCache and CompactionScheduler
    db.tableCache = new TableCache(db.options.maxOpenFiles);
    db.compactionScheduler = new CompactionScheduler(name, db.options, db.versions);

    // Initialize Worker Thread for async compaction (best-effort)
    try {
      const workerPath = new URL('./compaction/worker.js', import.meta.url);
      db.compactionWorker = new Worker(workerPath);
      // Prevent MaxListenersExceededWarning when many DB instances are created
      db.compactionWorker.setMaxListeners(200);
      db.compactionWorker.on('error', () => {
        // Worker failed to start — detach and fallback to sync
        db.compactionScheduler.detachWorker().catch(() => {});
        db.compactionWorker = null;
      });
      db.compactionScheduler.attachWorker(db.compactionWorker);
    } catch {
      // Worker not available — fallback to sync compaction
    }

    // Recover from all WAL logs
    const logFiles = existsSync(name)
      ? readdirSync(name).filter(f => f.endsWith('.log')).sort()
      : [];

    if (logFiles.length > 0) {
      db.mem = new MemTable(db.cmp);
      for (const logFile of logFiles) {
        const logPath = join(name, logFile);
        try {
          const reader = new LogReader(logPath);
          let record: Buffer | null;
          while ((record = reader.readNext()) !== null) {
            const batch = WriteBatch.decode(record);
            db.seq++;
            batch.iterate((key, value, type) => {
              db.mem.add(db.seq, type, key, value);
            });
          }
        } catch {
          // Skip corrupted log files — recovery is best-effort
        }
        // Delete old logs unless reuseLogs is set
        if (!db.options.reuseLogs) {
          try { unlinkSync(logPath); } catch { /* ignore */ }
        }
      }
      db.versions.setLastSequence(db.seq);
    } else {
      db.mem = new MemTable(db.cmp);
    }

    // Open new log
    db.logNumber = db.versions.allocateFileNumber();
    const newLogPath = logFileName(name, db.logNumber);
    db.log = new LogWriter(newLogPath);

    return db;
  }

  static async destroyDB(name: string): Promise<void> {
    if (!existsSync(name)) return;
    const entries = readdirSync(name);
    for (const entry of entries) {
      const fullPath = join(name, entry);
      try { unlinkSync(fullPath); } catch { /* best-effort */ }
    }
    try { rmdirSync(name); } catch { /* may have subdirs */ }
  }

  // ─── Read Path ────────────────────────────────────────────

  async get(key: string | Buffer, options: ReadOptions = {}): Promise<string | Buffer | null> {
    const kbuf = encodeUserKey(key, this.options.keyEncoding);
    const opts = { ...defaultReadOptions(), ...options };
    const snapshot = opts.snapshot ? opts.snapshot.sequence : this.seq;

    // 1. Active MemTable
    const memResult = this.mem.get(kbuf, snapshot);
    if (memResult) {
      if (memResult.valueType === ValueType.Deletion) return null;
      return decodeUserValue(memResult.value, this.options.valueEncoding);
    }

    // 2. Immutable MemTable
    if (this.immutableMem) {
      const immResult = this.immutableMem.get(kbuf, snapshot);
      if (immResult) {
        if (immResult.valueType === ValueType.Deletion) return null;
        return decodeUserValue(immResult.value, this.options.valueEncoding);
      }
    }

    // 3. SSTables
    const val = await this.sstableGet(kbuf, snapshot);
    if (val === null) return null;
    return decodeUserValue(val, this.options.valueEncoding);
  }

  private async sstableGet(key: Buffer, snapshot: SequenceNumber): Promise<Buffer | null> {
    const currentVersion = this.versions.current();
    for (let level = 0; level < 7; level++) {
      const files = currentVersion.files(level);
      if (files.length === 0) continue;

      if (level === 0) {
        // Level-0: files may overlap, check newest first
        for (let i = files.length - 1; i >= 0; i--) {
          const result = await this.lookupFile(files[i], key, snapshot);
          if (result !== undefined) return result;
        }
      } else {
        // Level-1+: binary search for the file whose range contains key
        const file = this.findFile(files, key);
        if (file) {
          const result = await this.lookupFile(file, key, snapshot);
          if (result !== undefined) return result;
        }
      }
    }
    return null;
  }

  private async lookupFile(
    file: FileMetaData,
    key: Buffer,
    snapshot: SequenceNumber
  ): Promise<Buffer | null | undefined> {
    const filename = tableFileName(this.dbname, file.fileNumber);
    if (!existsSync(filename)) {
      throw new IOError(`SSTable file not found: ${filename}`);
    }

    const table = await this.tableCache.getTable(filename, file.fileNumber, this.options.paranoidChecks);
    // Use internalGet — but it doesn't know about sequence numbers
    // Seek to the entry and check the key/type
    const iter = table.iterator(this.cmp);
    const ikey = encodeInternalKey(key, snapshot, ValueType.Value);
    await iter.seek(ikey);
    if (!iter.valid()) return undefined;

    const foundKey = iter.key();
    const decoded = decodeInternalKey(foundKey);

    // paranoidChecks: validate InternalKey integrity
    if (this.options.paranoidChecks) {
      if (decoded.sequence < 0n || decoded.sequence > ((1n << 56n) - 1n)) {
        throw new CorruptionError(
          `Corrupt internal key: invalid sequence ${decoded.sequence} in ${filename}`
        );
      }
      if (decoded.valueType !== ValueType.Deletion && decoded.valueType !== ValueType.Value) {
        throw new CorruptionError(
          `Corrupt internal key: invalid value type ${decoded.valueType} in ${filename}`
        );
      }
    }

    if (this.cmp.compare(decoded.userKey, key) !== 0) return undefined;
    if (decoded.sequence > snapshot) return undefined;

    if (decoded.valueType === ValueType.Deletion) return null;
    return iter.value();
  }

  private findFile(files: FileMetaData[], key: Buffer): FileMetaData | null {
    let lo = 0;
    let hi = files.length - 1;
    while (lo <= hi) {
      const mid = Math.floor((lo + hi) / 2);
      const f = files[mid];
      // Compare user keys only — InternalKey suffix would skew range checks
      const largestUK = decodeInternalKey(f.largest).userKey;
      const smallestUK = decodeInternalKey(f.smallest).userKey;
      if (Buffer.compare(largestUK, key) < 0) {
        lo = mid + 1;
      } else if (Buffer.compare(smallestUK, key) > 0) {
        hi = mid - 1;
      } else {
        return f;
      }
    }
    return null;
  }

  // ─── Write Path ───────────────────────────────────────────

  async put(key: string | Buffer, value: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const batch = new WriteBatch();
    batch.put(
      encodeUserKey(key, this.options.keyEncoding),
      encodeUserValue(value, this.options.valueEncoding)
    );
    return this.write(batch, options);
  }

  async delete(key: string | Buffer, options: WriteOptions = {}): Promise<void> {
    const batch = new WriteBatch();
    batch.delete(encodeUserKey(key, this.options.keyEncoding));
    return this.write(batch, options);
  }

  async write(batch: WriteBatch, options: WriteOptions = {}): Promise<void> {
    const opts = { ...defaultWriteOptions(), ...options };
    // Serialize writes to prevent race conditions (fix: concurrent write data loss)
    const prev = this.writeLock;
    let releaseWriteLock!: () => void;
    this.writeLock = new Promise<void>(resolve => { releaseWriteLock = resolve; });
    await prev;

    try {
    this.seq++;

    // Write to WAL
    const record = batch.encode();
    this.log.addRecord(record);

    // Sync if requested
    if (opts.sync) {
      this.log.sync();
    }

    // Write to MemTable
    batch.iterate((key, value, type) => {
      this.mem.add(this.seq, type, key, value);
    });

    // Check threshold
    if (this.mem.approximateMemoryUsage() >= this.options.writeBufferSize) {
      await this.makeRoomForWrite();
    }
    } finally {
      releaseWriteLock();
    }
  }

  // ─── Iterator ─────────────────────────────────────────────

  iterator(options?: ReadOptions): Iterator {
    const opts = { ...defaultReadOptions(), ...options };
    const children: IterLike[] = [];

    // Active MemTable
    children.push(this.mem.getInternalIterator());

    // Immutable MemTable
    if (this.immutableMem) {
      children.push(this.immutableMem.getInternalIterator());
    }

    // SSTable lazy loader: opens all .ldb files on first seekToFirst/seek
    const currentVersion = this.versions.current();
    const dbname = this.dbname;
    const tableCache = this.tableCache;
    const cmp = this.cmp;

    const sstableFactory = async (): Promise<IterLike[]> => {
      const result: IterLike[] = [];
      for (let level = 0; level < 7; level++) {
        const files = currentVersion.files(level);
        for (const f of files) {
          const fn = tableFileName(dbname, f.fileNumber);
          if (!existsSync(fn)) continue;
          try {
            const table = await tableCache.getTable(fn, f.fileNumber);
            result.push(table.iterator(cmp) as unknown as IterLike);
          } catch {
            // skip unreadable files
          }
        }
      }
      return result;
    };

    const snapSeq = opts.snapshot ? opts.snapshot.sequence : undefined;
    return new Iterator(children, [sstableFactory], this.makeInternalComparator(this.cmp), snapSeq);
  }

  // ─── Snapshot ─────────────────────────────────────────────

  getSnapshot(): Snapshot {
    const snap = new Snapshot(this.seq, () => {
      const idx = this.snapshots.indexOf(snap);
      if (idx >= 0) this.snapshots.splice(idx, 1);
    });
    this.snapshots.push(snap);
    return snap;
  }

  releaseSnapshot(snapshot: Snapshot): void {
    const idx = this.snapshots.indexOf(snapshot);
    if (idx >= 0) this.snapshots.splice(idx, 1);
  }

  // ─── Misc ─────────────────────────────────────────────────

  getProperty(property: string): string {
    const current = this.versions.current();

    if (property === 'leveldb.memtable-size') {
      return String(this.mem.approximateMemoryUsage());
    }

    if (property === 'leveldb.stats') {
      const lines: string[] = [];
      for (let level = 0; level < 7; level++) {
        const files = current.files(level);
        const totalSize = files.reduce((sum, f) => sum + f.fileSize, 0);
        lines.push(`Level ${level}: ${files.length} files, ${(totalSize / 1024 / 1024).toFixed(2)} MB`);
      }
      return lines.join('\n');
    }

    if (property.startsWith('leveldb.num-files-at-level')) {
      const level = parseInt(property.replace('leveldb.num-files-at-level', ''), 10);
      if (isNaN(level) || level < 0 || level > 6) return '0';
      return String(current.files(level).length);
    }

    if (property === 'leveldb.sstables') {
      const lines: string[] = [];
      for (let level = 0; level < 7; level++) {
        for (const f of current.files(level)) {
          lines.push(`Level-${level}: ${f.fileNumber}.ldb (${(f.fileSize / 1024).toFixed(1)} KB) [${decodeInternalKey(f.smallest).userKey.toString('hex')} .. ${decodeInternalKey(f.largest).userKey.toString('hex')}]`);
        }
      }
      return lines.join('\n');
    }

    return '';
  }

  getApproximateSizes(ranges: Range[]): bigint[] {
    const current = this.versions.current();
    const result: bigint[] = [];
    for (const range of ranges) {
      let size = 0n;
      for (let level = 0; level < 7; level++) {
        for (const f of current.files(level)) {
          const fBegin = decodeInternalKey(f.smallest).userKey;
          const fEnd = decodeInternalKey(f.largest).userKey;
          if (Buffer.compare(fEnd, range.start) < 0) continue;
          if (Buffer.compare(fBegin, range.limit) > 0) continue;
          size += BigInt(f.fileSize);
        }
      }
      result.push(size);
    }
    return result;
  }

  async compactRange(begin?: Buffer, end?: Buffer): Promise<void> {
    for (let level = 0; level < 6; level++) {
      const current = this.versions.current();
      const files = current.files(level);
      if (files.length === 0) continue;

      let rangeFiles = files;
      if (begin || end) {
        rangeFiles = files.filter(f => {
          const fBegin = decodeInternalKey(f.smallest).userKey;
          const fEnd = decodeInternalKey(f.largest).userKey;
          if (end && Buffer.compare(fBegin, end) > 0) return false;
          if (begin && Buffer.compare(fEnd, begin) < 0) return false;
          return true;
        });
      }

      if (rangeFiles.length === 0) continue;
      await this.compactionScheduler.compactLevel(level);
    }
  }

  // ─── Flush ────────────────────────────────────────────────

  private async makeRoomForWrite(): Promise<void> {
    // Freeze current MemTable
    this.immutableMem = this.mem;
    this.mem = new MemTable(this.cmp);

    // Flush to SSTable
    await this.flushMemTable(this.immutableMem);

    // Cleanup
    this.immutableMem = null;
  }

  private async flushMemTable(mem: MemTable): Promise<void> {
    const fileNumber = this.versions.allocateFileNumber();
    const filename = tableFileName(this.dbname, fileNumber);
    const builder = new TableBuilder(filename, this.options);

    const iter = mem.getInternalIterator();
    iter.seekToFirst();
    let smallest: Buffer | null = null;
    let largest: Buffer | null = null;

    while (iter.valid()) {
      const key = iter.key();
      const value = iter.value();
      if (!smallest) smallest = key;
      largest = key;
      await builder.add(key, value);
      iter.next();
    }

    if (!smallest || !largest) {
      // Empty MemTable — nothing to flush
      return;
    }

    await builder.finish();

    const fileSize = statSync(filename).size;
    const meta: FileMetaData = {
      fileNumber,
      fileSize,
      smallest,
      largest,
    };

    // Register in Version
    const edit = this.versions.newVersionEdit();
    edit.addFile(0, meta); // Level-0
    await this.versions.logAndApply(edit);

    // Trigger compaction (async via Worker if available, else sync)
    if (!this.compactionScheduler.maybeCompactAsync()) {
      this.compactionScheduler.maybeCompact().catch(() => {});
    }
  }

  // ─── Internal Helpers ─────────────────────────────────────

  private makeInternalComparator(userCmp: Comparator): Comparator {
    return {
      name: () => 'leveldb.InternalKeyComparator',
      compare: (a: Buffer, b: Buffer) => {
        const dA = decodeInternalKey(a);
        const dB = decodeInternalKey(b);
        const r = userCmp.compare(dA.userKey, dB.userKey);
        if (r !== 0) return r;
        if (dA.sequence > dB.sequence) return -1;
        if (dA.sequence < dB.sequence) return 1;
        return 0;
      },
      findShortestSeparator: () => Buffer.alloc(0),
      findShortSuccessor: () => Buffer.alloc(0),
    };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;

    // Flush active MemTable before closing (fix: data loss on close)
    if (this.mem && this.mem.approximateMemoryUsage() > 0) {
      try {
        await this.flushMemTable(this.mem);
      } catch {
        // best-effort flush
      }
    }
    // Also flush immutable if present
    if (this.immutableMem) {
      try {
        await this.flushMemTable(this.immutableMem);
        this.immutableMem = null;
      } catch {
        // best-effort flush
      }
    }

    // Terminate Worker Thread and clean up listeners (fix: listener leak)
    if (this.compactionWorker) {
      try {
        await this.compactionWorker.terminate();
      } catch {
        // Worker may already be dead
      }
      this.compactionWorker = null;
    }
    await this.log.close();
  }
}
