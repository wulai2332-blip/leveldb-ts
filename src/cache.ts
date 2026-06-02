interface LRUNode {
  key: Buffer;
  value: Buffer;
  charge: number;
  prev: LRUNode;
  next: LRUNode;
}

export interface CacheHandle {
  value: Buffer;
  charge: number;
}

export class LRUCache {
  private map = new Map<string, LRUNode>();
  private totalCharge_ = 0;
  private readonly capacity: number;
  private head: LRUNode;
  private onEvict: ((key: Buffer, value: Buffer) => void) | null;

  constructor(capacity: number, onEvict?: (key: Buffer, value: Buffer) => void) {
    this.capacity = capacity;
    this.onEvict = onEvict ?? null;
    this.head = {} as LRUNode;
    this.head.prev = this.head;
    this.head.next = this.head;
  }

  insert(key: Buffer, value: Buffer, charge: number): CacheHandle {
    this.makeRoom(charge);
    const node: LRUNode = {
      key: Buffer.from(key),
      value: Buffer.from(value),
      charge,
      prev: this.head,
      next: this.head,
    };
    this.map.set(this.keyString(key), node);
    this.addToList(node);
    this.totalCharge_ += charge;

    // Evict if the new entry alone exceeds capacity (fix: zero-size cache, oversize entry)
    while (this.totalCharge_ > this.capacity && this.map.size > 0) {
      const lru = this.head.prev;
      if (lru === this.head) break;
      this.removeFromList(lru);
      this.map.delete(this.keyString(lru.key));
      this.totalCharge_ -= lru.charge;
      if (this.onEvict) this.onEvict(lru.key, lru.value);
    }
    return { value: node.value, charge };
  }

  lookup(key: Buffer): CacheHandle | null {
    const node = this.map.get(this.keyString(key));
    if (!node) return null;
    this.moveToHead(node);
    return { value: node.value, charge: node.charge };
  }

  erase(key: Buffer): void {
    const node = this.map.get(this.keyString(key));
    if (!node) return;
    this.removeFromList(node);
    this.map.delete(this.keyString(key));
    this.totalCharge_ -= node.charge;
  }

  totalCharge(): number {
    return this.totalCharge_;
  }

  /** Remove all entries from the cache (fix: add prune support). */
  prune(): void {
    this.map.clear();
    this.head.prev = this.head;
    this.head.next = this.head;
    this.totalCharge_ = 0;
  }

  private makeRoom(charge: number): void {
    while (this.totalCharge_ + charge > this.capacity && this.map.size > 0) {
      const lru = this.head.prev;
      this.removeFromList(lru);
      this.map.delete(this.keyString(lru.key));
      this.totalCharge_ -= lru.charge;
      if (this.onEvict) {
        this.onEvict(lru.key, lru.value);
      }
    }
  }

  private keyString(key: Buffer): string {
    return key.toString('hex');
  }

  private addToList(node: LRUNode): void {
    node.next = this.head.next;
    node.prev = this.head;
    this.head.next.prev = node;
    this.head.next = node;
  }

  private removeFromList(node: LRUNode): void {
    node.prev.next = node.next;
    node.next.prev = node.prev;
  }

  private moveToHead(node: LRUNode): void {
    this.removeFromList(node);
    this.addToList(node);
  }
}
