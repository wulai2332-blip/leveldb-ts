import type { FileMetaData } from '../types.js';

export class Version {
  private files_: FileMetaData[][] = [];

  constructor() {
    for (let i = 0; i < 7; i++) {
      this.files_.push([]);
    }
  }

  files(level: number): FileMetaData[] {
    return this.files_[level];
  }

  addFile(level: number, f: FileMetaData): void {
    this.files_[level].push(f);
    // Keep files sorted by smallest key
    this.files_[level].sort((a, b) => Buffer.compare(a.smallest, b.smallest));
  }

  removeFile(level: number, fileNumber: number): void {
    this.files_[level] = this.files_[level].filter(f => f.fileNumber !== fileNumber);
  }
}
