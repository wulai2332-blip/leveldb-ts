import type { Env } from './env.js';
import type { Comparator } from './comparator.js';
import type { LRUCache } from './cache.js';
import type { FilterPolicy } from './sstable/bloom.js';
import type { Logger } from './logger.js';
import type { Snapshot } from './snapshot.js';

export enum CompressionType {
  None = 0,
  Snappy = 1,
  Zstd = 2,
}

export type Encoding = 'utf8' | 'buffer';

export interface DBOptions {
  createIfMissing?: boolean;
  errorIfExists?: boolean;
  paranoidChecks?: boolean;
  writeBufferSize?: number;
  maxOpenFiles?: number;
  blockSize?: number;
  blockRestartInterval?: number;
  maxFileSize?: number;
  compression?: CompressionType;
  zstdCompressionLevel?: number;
  reuseLogs?: boolean;
  filterPolicy?: FilterPolicy;
  comparator?: Comparator;
  blockCache?: LRUCache;
  env?: Env;
  logger?: Logger;
  keyEncoding?: Encoding;
  valueEncoding?: Encoding;
}

export interface ReadOptions {
  verifyChecksums?: boolean;
  fillCache?: boolean;
  snapshot?: Snapshot | null;
}

export interface WriteOptions {
  sync?: boolean;
}

const kWriteBufferSize = 4 * 1024 * 1024;
const kMaxOpenFiles = 1000;
const kBlockSize = 4096;
const kBlockRestartInterval = 16;
const kMaxFileSize = 2 * 1024 * 1024;

export function defaultDBOptions(): Required<Omit<DBOptions, 'filterPolicy' | 'comparator' | 'blockCache' | 'env' | 'logger'>> {
  return {
    createIfMissing: false,
    errorIfExists: false,
    paranoidChecks: false,
    writeBufferSize: kWriteBufferSize,
    maxOpenFiles: kMaxOpenFiles,
    blockSize: kBlockSize,
    blockRestartInterval: kBlockRestartInterval,
    maxFileSize: kMaxFileSize,
    compression: CompressionType.Snappy,
    zstdCompressionLevel: 1,
    reuseLogs: false,
    keyEncoding: 'buffer',
    valueEncoding: 'buffer',
  };
}

export function defaultReadOptions(): Required<Omit<ReadOptions, 'snapshot'>> {
  return {
    verifyChecksums: false,
    fillCache: true,
  };
}

export function defaultWriteOptions(): Required<WriteOptions> {
  return {
    sync: false,
  };
}
