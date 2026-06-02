const kBlockSize = 4096;

export class Arena {
  private blocks: Buffer[] = [];
  private allocBytes = 0;
  private currentBlock: Buffer | null = null;
  private currentOffset = 0;

  allocate(bytes: number): Buffer {
    if (this.currentBlock === null || this.currentOffset + bytes > this.currentBlock.length) {
      const blockSize = Math.max(kBlockSize, bytes);
      this.currentBlock = Buffer.alloc(blockSize);
      this.blocks.push(this.currentBlock);
      this.currentOffset = 0;
    }
    const offset = this.currentOffset;
    this.currentOffset += bytes;
    return this.currentBlock.subarray(offset, offset + bytes);
  }

  memoryUsage(): number {
    return this.blocks.reduce((sum, b) => sum + b.length, 0);
  }
}
