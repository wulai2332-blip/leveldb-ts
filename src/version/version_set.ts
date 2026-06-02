import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Version } from './version.js';
import { VersionEdit } from './version_edit.js';
import { LogWriter } from '../wal/writer.js';
import { LogReader } from '../wal/reader.js';
import type { DBOptions } from '../options.js';
import type { Comparator } from '../comparator.js';
import type { Env } from '../env.js';
import type { SequenceNumber } from '../types.js';

export class VersionSet {
  private dbname: string;
  private options: Required<DBOptions>;
  private cmp: Comparator;
  private env: Env;
  private current_: Version = new Version();
  private logNumber = 0;
  private prevLogNumber = 0;
  private nextFileNumber = 0;
  private lastSequence_: SequenceNumber = 0n;
  private manifestFileNumber = 0;
  private descriptorLog: LogWriter | null = null;

  constructor(dbname: string, options: Required<DBOptions>, cmp: Comparator, env: Env) {
    this.dbname = dbname;
    this.options = options;
    this.cmp = cmp;
    this.env = env;
  }

  async initialize(createIfMissing: boolean): Promise<void> {
    const currentPath = join(this.dbname, 'CURRENT');
    if (!existsSync(currentPath)) {
      if (!createIfMissing) throw new Error(`Database ${this.dbname} does not exist`);
      mkdirSync(this.dbname, { recursive: true });
      this.nextFileNumber = 1;
      this.manifestFileNumber = 1;
      this.logNumber = 0;
      const manifestPath = this.manifestPath();
      this.descriptorLog = new LogWriter(manifestPath);
      const edit = new VersionEdit();
      edit.setComparatorName(this.cmp.name());
      edit.setLogNumber(0);
      edit.setNextFile(this.nextFileNumber);
      edit.setLastSequence(0n);
      this.writeSnapshot(edit);
      this.setCurrentFile();
    } else {
      const currentContent = readFileSync(currentPath, 'utf8').trim();
      this.manifestFileNumber = parseInt(currentContent.split('-')[1], 10);
      await this.recover();
    }
  }

  current(): Version {
    return this.current_;
  }

  lastSequence(): SequenceNumber {
    return this.lastSequence_;
  }

  setLastSequence(seq: SequenceNumber): void {
    this.lastSequence_ = seq;
  }

  newVersionEdit(): VersionEdit {
    return new VersionEdit();
  }

  manifestFileNum(): number {
    return this.manifestFileNumber;
  }

  allocateFileNumber(): number {
    return this.nextFileNumber++;
  }

  getDBName(): string {
    return this.dbname;
  }

  async logAndApply(edit: VersionEdit): Promise<void> {
    if (edit.logNumber !== null) this.logNumber = edit.logNumber;
    if (edit.prevLogNumber !== null) this.prevLogNumber = edit.prevLogNumber;
    if (edit.nextFileNumber !== null) this.nextFileNumber = Math.max(this.nextFileNumber, edit.nextFileNumber);
    if (edit.lastSequence !== null) this.lastSequence_ = edit.lastSequence;

    // Apply to current version
    for (const [level, files] of edit.deletedFiles) {
      for (const fn of files) {
        this.current_.removeFile(level, fn);
      }
    }
    for (const { level, meta } of edit.addedFiles) {
      this.current_.addFile(level, meta);
    }

    this.writeSnapshot(edit);
  }

  private async recover(): Promise<void> {
    const manifestPath = this.manifestPath();
    const reader = new LogReader(manifestPath);
    let record: Buffer | null;
    while ((record = reader.readNext()) !== null) {
      const edit = VersionEdit.decode(record);
      if (edit.comparatorName && edit.comparatorName !== this.cmp.name()) {
        throw new Error(`Comparator mismatch: expected ${this.cmp.name()}, got ${edit.comparatorName}`);
      }
      this.applyEdit(edit);
    }
  }

  private applyEdit(edit: VersionEdit): void {
    if (edit.logNumber !== null) this.logNumber = edit.logNumber;
    if (edit.prevLogNumber !== null) this.prevLogNumber = edit.prevLogNumber;
    if (edit.nextFileNumber !== null) this.nextFileNumber = Math.max(this.nextFileNumber, edit.nextFileNumber);
    if (edit.lastSequence !== null && edit.lastSequence > this.lastSequence_) {
      this.lastSequence_ = edit.lastSequence;
    }
    for (const [level, files] of edit.deletedFiles) {
      for (const fn of files) {
        this.current_.removeFile(level, fn);
      }
    }
    for (const { level, meta } of edit.addedFiles) {
      this.current_.addFile(level, meta);
    }
  }

  private writeSnapshot(edit: VersionEdit): void {
    if (!this.descriptorLog) {
      this.descriptorLog = new LogWriter(this.manifestPath());
    }
    this.descriptorLog.addRecord(edit.encode());
  }

  private manifestPath(): string {
    return join(this.dbname, `MANIFEST-${String(this.manifestFileNumber).padStart(6, '0')}`);
  }

  private setCurrentFile(): void {
    writeFileSync(join(this.dbname, 'CURRENT'), `MANIFEST-${String(this.manifestFileNumber).padStart(6, '0')}\n`);
  }
}
