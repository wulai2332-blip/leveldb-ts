// --- Varint32 ---

export function putVarint32(value: number): Buffer {
  const buf = Buffer.alloc(5);
  let i = 0;
  let v = value >>> 0; // coerce to unsigned
  while (v >= 0x80) {
    buf[i++] = (v & 0x7f) | 0x80;
    v >>>= 7;
  }
  buf[i++] = v & 0x7f;
  return buf.subarray(0, i);
}

export function getVarint32(buf: Buffer, offset = 0): [number, number] {
  let result = 0;
  let shift = 0;
  let i = offset;
  while (i < buf.length) {
    const byte = buf[i++];
    result |= (byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) break;
    shift += 7;
  }
  return [result >>> 0, i - offset];
}

// --- Varint64 ---

export function putVarint64(value: bigint): Buffer {
  const buf = Buffer.alloc(10);
  let i = 0;
  let v = value;
  while (v >= 0x80n) {
    buf[i++] = Number((v & 0x7fn) | 0x80n);
    v >>= 7n;
  }
  buf[i++] = Number(v & 0x7fn);
  return buf.subarray(0, i);
}

export function getVarint64(buf: Buffer, offset = 0): [bigint, number] {
  let result = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const byte = BigInt(buf[i++]);
    result |= (byte & 0x7fn) << shift;
    if ((byte & 0x80n) === 0n) break;
    shift += 7n;
  }
  return [result, i - offset];
}

// --- Fixed32 (little-endian) ---

export function putFixed32(buf: Buffer, value: number): void {
  buf.writeUInt32LE(value, 0);
}

export function getFixed32(buf: Buffer, offset = 0): number {
  return buf.readUInt32LE(offset);
}

// --- CRC32 (table-driven) ---

const kCRCTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let j = 0; j < 8; j++) {
      c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
    }
    table[i] = c;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff >>> 0;
  for (let i = 0; i < data.length; i++) {
    crc = kCRCTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export function crc32cMask(crc: number): number {
  // Rotate right by 15 bits and add constant
  return (((crc >>> 15) | (crc << 17)) + 0xa282ead8) >>> 0;
}

export function crc32cUnmask(masked: number): number {
  const rot = (masked - 0xa282ead8) >>> 0;
  return ((rot >>> 17) | (rot << 15)) >>> 0;
}
