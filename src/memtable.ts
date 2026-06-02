import { SkipList, SkipListIterator } from './memtable/skiplist.js';
import { Arena } from './arena.js';
import { Comparator } from './comparator.js';
import { encodeInternalKey, decodeInternalKey, ValueType, SequenceNumber } from './types.js';

export interface MemTableEntry {
  value: Buffer;
  valueType: ValueType;
}

export class MemTable {
  private skiplist: SkipList;
  private arena: Arena;
  private memUsage = 0;

  constructor(
    private cmp: Comparator,
  ) {
    this.arena = new Arena();
    this.skiplist = new SkipList(this.makeInternalComparator(cmp), this.arena);
  }

  add(sequence: SequenceNumber, valueType: ValueType, key: Buffer, value: Buffer): void {
    const ikey = encodeInternalKey(key, sequence, valueType);
    this.skiplist.insert(ikey, value);
    this.memUsage += ikey.length + value.length;
  }

  get(lookupKey: Buffer, snapshot: SequenceNumber): MemTableEntry | null {
    const it = this.skiplist.iterator();
    it.seek(encodeInternalKey(lookupKey, snapshot, ValueType.Value));
    if (!it.valid()) return null;
    const ikey = it.key();
    const decoded = decodeInternalKey(ikey);
    if (this.cmp.compare(decoded.userKey, lookupKey) !== 0) return null;
    return { value: it.value(), valueType: decoded.valueType };
  }

  approximateMemoryUsage(): number {
    return this.memUsage;
  }

  getInternalIterator(): SkipListIterator {
    return this.skiplist.iterator();
  }

  private makeInternalComparator(userCmp: Comparator): Comparator {
    return {
      name: () => 'leveldb.InternalKeyComparator',
      compare: (a: Buffer, b: Buffer) => {
        const dA = decodeInternalKey(a);
        const dB = decodeInternalKey(b);
        const r = userCmp.compare(dA.userKey, dB.userKey);
        if (r !== 0) return r;
        // Descending sequence (newer first)
        if (dA.sequence > dB.sequence) return -1;
        if (dA.sequence < dB.sequence) return 1;
        return 0;
      },
      findShortestSeparator: () => Buffer.alloc(0),
      findShortSuccessor: () => Buffer.alloc(0),
    };
  }
}
