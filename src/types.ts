// ValueType: 0 = Deletion, 1 = Value
export const enum ValueType {
  Deletion = 0,
  Value = 1,
}

// SequenceNumber is a monotonically increasing 64-bit counter
export type SequenceNumber = bigint;

// InternalKey format: user_key + (sequence << 8 | valueType) in 8 bytes big-endian
// The trailing 8 bytes ensure: (a) same userKey sorted by decreasing seq, (b) value comes before deletion
export type InternalKey = Buffer;

// XOR mask to invert the upper 56 bits (sequence) for descending sort,
// while preserving the lower 8 bits (valueType) so Value > Deletion in byte order.
const kSeqInvertMask = 0xffffffffffffff00n;

// Maximum valid sequence number: 2^56 - 1 (upper 8 bits reserved for ValueType)
const kMaxSequenceNumber = (1n << 56n) - 1n;

export function encodeInternalKey(
  userKey: Buffer,
  sequence: SequenceNumber,
  valueType: ValueType
): Buffer {
  if (sequence < 0n || sequence > kMaxSequenceNumber) {
    throw new RangeError(
      `SequenceNumber out of range: ${sequence}. Must be in [0, 2^56-1]`
    );
  }
  const packed = Buffer.alloc(8);
  const combined = (sequence << 8n) | BigInt(valueType);
  // Invert sequence bits so larger seq → smaller bytes (descending sort)
  const inverted = combined ^ kSeqInvertMask;
  packed.writeBigUInt64BE(inverted, 0);
  return Buffer.concat([userKey, packed]);
}

export function decodeInternalKey(ikey: Buffer): {
  userKey: Buffer;
  sequence: SequenceNumber;
  valueType: ValueType;
} {
  const userKey = ikey.subarray(0, ikey.length - 8);
  const inverted = ikey.readBigUInt64BE(ikey.length - 8);
  const combined = inverted ^ kSeqInvertMask;
  const valueType = Number(combined & 0xffn) as ValueType;
  const sequence = combined >> 8n;
  return { userKey, sequence, valueType };
}

// FileMetaData used by Version
export interface FileMetaData {
  fileNumber: number;
  fileSize: number;
  smallest: InternalKey;
  largest: InternalKey;
}

// Range for GetApproximateSizes
export interface Range {
  start: Buffer;
  limit: Buffer;
}
