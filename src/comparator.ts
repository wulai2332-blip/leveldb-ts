export interface Comparator {
  name(): string;
  compare(a: Buffer, b: Buffer): number;
  findShortestSeparator(start: Buffer, limit: Buffer): Buffer;
  findShortSuccessor(key: Buffer): Buffer;
}

export class BytewiseComparator implements Comparator {
  name(): string {
    return 'leveldb.BytewiseComparator';
  }

  compare(a: Buffer, b: Buffer): number {
    return Buffer.compare(a, b);
  }

  findShortestSeparator(start: Buffer, limit: Buffer): Buffer {
    // Find shortest string >= start and < limit
    const minLen = Math.min(start.length, limit.length);
    let diffIndex = 0;
    while (diffIndex < minLen && start[diffIndex] === limit[diffIndex]) {
      diffIndex++;
    }
    if (diffIndex >= start.length) {
      return Buffer.from(start); // already minimal
    }
    const byte = start[diffIndex];
    if (byte < 0xff && byte + 1 < (diffIndex < limit.length ? limit[diffIndex] : 0xff)) {
      const result = Buffer.from(start.subarray(0, diffIndex + 1));
      result[diffIndex]++;
      return result;
    }
    return Buffer.from(start);
  }

  findShortSuccessor(key: Buffer): Buffer {
    // Find shortest string > key
    for (let i = key.length - 1; i >= 0; i--) {
      if (key[i] < 0xff) {
        const result = Buffer.from(key.subarray(0, i + 1));
        result[i]++;
        return result;
      }
    }
    // All bytes 0xff → append 0x00 byte to make longer key
    return Buffer.concat([key, Buffer.from([0x00])]);
  }
}
