# Changelog

## 0.1.0 (2026-06-02)

Initial release.

### Core Modules
- `types.ts` — SequenceNumber, InternalKey codec, ValueType, FileMetaData, Range
- `codec.ts` — Varint32/Varint64 codec, CRC32 checksum, Fixed32
- `status.ts` — Status codes (OK/NotFound/Corruption/NotSupported/IOError)
- `error.ts` — LevelDBError, NotFoundError, CorruptionError, IOError
- `options.ts` — DBOptions, ReadOptions, WriteOptions, CompressionType
- `logger.ts` — Logger interface, ConsoleLogger, NoopLogger

### Data Structures
- `arena.ts` — Arena memory pool allocator
- `cache.ts` — Generic LRU Cache with eviction
- `comparator.ts` — Comparator interface + BytewiseComparator
- `snapshot.ts` — Snapshot with Disposable and sequence isolation
- `write_batch.ts` — Atomic batch operations with encode/decode
- `iterator.ts` — Iterator, DBIter, MergingIterator with AsyncDisposable

### MemTable
- `memtable/skiplist.ts` — Probabilistic SkipList (12 levels, 1/4 branching)
- `memtable.ts` — MemTable with internal key comparator

### SSTable
- `sstable/block.ts` — Block reader with restart-based iteration
- `sstable/block_builder.ts` — Block builder with shared key prefix encoding
- `sstable/bloom.ts` — BloomFilterPolicy (k-probe, CRC32-based hashing)
- `sstable/table.ts` — Table reader with two-level index lookup
- `sstable/table_builder.ts` — Table builder with Snappy/Zstd compression
- `sstable/filename.ts` — SSTable file naming conventions

### WAL (Write-Ahead Log)
- `wal/writer.ts` — LogWriter (32KB blocks, Full/First/Middle/Last records)
- `wal/reader.ts` — LogReader (CRC verification, cross-block records)

### Version Management
- `version/version_edit_tag.ts` — MANIFEST tag constants
- `version/version_edit.ts` — VersionEdit encode/decode (8 tag types)
- `version/version.ts` — Version (7-level file tracking)
- `version/version_set.ts` — VersionSet (MANIFEST + CURRENT + logAndApply)

### Compaction
- `compaction/scheduler.ts` — Compaction scheduling with Worker Thread
- `compaction/worker.ts` — Worker Thread handler (CompactMemtable/DoCompaction)

### Top-level
- `env.ts` — Env abstraction + NodeEnv (fs/promises)
- `repair.ts` — RepairDB for corrupt databases
- `table_cache.ts` — SSTable-level LRU cache
- `db.ts` — DB abstract class
- `db_impl.ts` — DBImpl core scheduler (full LSM-Tree pipeline)
- `index.ts` — Public API barrel export

### Testing
- 472 test cases across 21 testing methodologies
- 100% source module coverage (34/34 modules)
- Test methodologies: white-box, black-box, parameterized, exception, boundary, equivalence, state transition, decision table, interface contract, smoke, integration, regression, load/stress, mock/stub/spy, fuzz/random, mutation, acceptance/E2E, concurrent/race, standalone VersionSet, standalone Compaction Worker, compression paths
