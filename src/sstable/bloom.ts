import { crc32 } from '../codec.js';

export interface FilterPolicy {
  name(): string;
  createFilter(keys: Buffer[]): Buffer;
  keyMayMatch(key: Buffer, filter: Buffer): boolean;
}

export function newBloomFilterPolicy(bitsPerKey: number): FilterPolicy {
  return new BloomFilterPolicy(bitsPerKey);
}

class BloomFilterPolicy implements FilterPolicy {
  private k: number; // number of hash functions

  constructor(private bitsPerKey: number) {
    // k = bits_per_key * ln(2) ≈ bits_per_key * 0.69
    this.k = Math.max(1, Math.floor(bitsPerKey * 0.69));
  }

  name(): string {
    return 'leveldb.BuiltinBloomFilter2';
  }

  createFilter(keys: Buffer[]): Buffer {
    const bits = keys.length * this.bitsPerKey;
    const bytes = Math.max(64, Math.ceil(bits / 8));
    const filter = Buffer.alloc(bytes + 1); // +1 for k_ probe count
    filter[bytes] = this.k;

    for (const key of keys) {
      let h = crc32(key);
      const delta = (h >> 17) | (h << 15); // rotate right 17
      for (let j = 0; j < this.k; j++) {
        const bitpos = h % (bytes * 8);
        filter[Math.floor(bitpos / 8)] |= 1 << (bitpos % 8);
        h = (h + delta) >>> 0;
      }
    }
    return filter;
  }

  keyMayMatch(key: Buffer, filter: Buffer): boolean {
    const bytes = filter.length - 1;
    if (bytes < 1) return false;
    const k = filter[bytes];
    if (k > 30) return true; // conservatively say yes for safety

    let h = crc32(key);
    const delta = (h >> 17) | (h << 15);
    for (let j = 0; j < k; j++) {
      const bitpos = h % (bytes * 8);
      if ((filter[Math.floor(bitpos / 8)] & (1 << (bitpos % 8))) === 0) {
        return false;
      }
      h = (h + delta) >>> 0;
    }
    return true;
  }
}
