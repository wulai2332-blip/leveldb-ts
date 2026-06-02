import type { SequenceNumber } from './types.js';

export class Snapshot implements Disposable {
  readonly sequence: SequenceNumber;
  private onRelease: (() => void) | null;

  constructor(sequence: SequenceNumber, onRelease?: () => void) {
    this.sequence = sequence;
    this.onRelease = onRelease ?? null;
  }

  [Symbol.dispose](): void {
    if (this.onRelease) {
      this.onRelease();
      this.onRelease = null;
    }
  }
}
