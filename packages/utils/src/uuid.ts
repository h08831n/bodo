import nodeCrypto from 'node:crypto';

/**
 * RFC 9562 compliant UUIDv7 generator.
 *
 * UUIDv7 format (128 bits):
 * - bits 0..47:   Unix timestamp in milliseconds (48 bits)
 * - bits 48..51:  Version (4 bits, 0b0111 = 7)
 * - bits 52..63:  Sub-millisecond sequence counter (12 bits)
 * - bits 64..65:  Variant (2 bits, 0b10)
 * - bits 66..127: Cryptographically secure random data (62 bits)
 *
 * Guarantees time-ordered, monotonic sortability within and across milliseconds.
 */

let lastTimestamp = -1;
let sequenceCounter = 0;

export function newId(): string {
  let now = Date.now();

  if (now > lastTimestamp) {
    lastTimestamp = now;
    // Initialize sequence counter with a random 12-bit offset for collision resistance
    const randomOffset = Math.floor(Math.random() * 0x800);
    sequenceCounter = randomOffset;
  } else {
    // Within the same millisecond, increment sequence counter to ensure monotonic ordering
    sequenceCounter = (sequenceCounter + 1) & 0xfff;
    if (sequenceCounter === 0) {
      // Counter overflowed in the same millisecond: advance timestamp by 1ms
      now = lastTimestamp + 1;
      lastTimestamp = now;
    }
  }

  // Allocate 16 bytes
  const bytes = new Uint8Array(16);

  // Fill random bytes using standard crypto
  const g = globalThis as unknown as {
    crypto?: { getRandomValues?: (b: Uint8Array) => Uint8Array };
  };
  if (typeof g.crypto?.getRandomValues === 'function') {
    g.crypto.getRandomValues(bytes);
  } else {
    nodeCrypto.randomFillSync(bytes);
  }

  // Write 48-bit timestamp (bytes 0..5, big-endian)
  bytes[0] = (now / 0x10000000000) & 0xff;
  bytes[1] = (now / 0x100000000) & 0xff;
  bytes[2] = (now / 0x1000000) & 0xff;
  bytes[3] = (now / 0x10000) & 0xff;
  bytes[4] = (now / 0x100) & 0xff;
  bytes[5] = now & 0xff;

  // Byte 6: 4-bit version (0x7) + upper 4 bits of 12-bit sequenceCounter
  bytes[6] = 0x70 | ((sequenceCounter >>> 8) & 0x0f);

  // Byte 7: lower 8 bits of 12-bit sequenceCounter
  bytes[7] = sequenceCounter & 0xff;

  // Byte 8: 2-bit variant (0b10 = 0x80) + 6 bits from random bytes
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);

  // Bytes 9..15 remain cryptographically random

  // Convert to canonical 8-4-4-4-12 string representation
  return formatUuid(bytes);
}

function formatUuid(bytes: Uint8Array): string {
  const hex: string[] = [];
  for (let i = 0; i < 16; i++) {
    const b = bytes[i] ?? 0;
    hex.push(b.toString(16).padStart(2, '0'));
  }
  return [
    hex.slice(0, 4).join(''),
    hex.slice(4, 6).join(''),
    hex.slice(6, 8).join(''),
    hex.slice(8, 10).join(''),
    hex.slice(10, 16).join(''),
  ].join('-');
}
