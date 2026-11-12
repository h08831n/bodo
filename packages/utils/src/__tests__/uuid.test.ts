import { describe, expect, it } from 'vitest';
import { newId } from '../uuid.js';

describe('UUIDv7 generator (newId)', () => {
  it('generates a valid UUID string format', () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
  });

  it('sets version 7 and RFC 4122/9562 variant', () => {
    for (let i = 0; i < 50; i++) {
      const id = newId();
      const parts = id.split('-');
      expect(parts).toHaveLength(5);
      // Version 7 nibble
      expect(parts[2]![0]).toBe('7');
      // Variant nibble must be 8, 9, a, or b
      expect(['8', '9', 'a', 'b']).toContain(parts[3]![0]!.toLowerCase());
    }
  });

  it('generates strictly monotonically increasing IDs in sequence', () => {
    const ids: string[] = [];
    for (let i = 0; i < 1000; i++) {
      ids.push(newId());
    }

    for (let i = 1; i < ids.length; i++) {
      expect(ids[i]! > ids[i - 1]!).toBe(true);
    }
  });

  it('generates unique IDs with no collisions', () => {
    const count = 5000;
    const set = new Set<string>();
    for (let i = 0; i < count; i++) {
      set.add(newId());
    }
    expect(set.size).toBe(count);
  });
});
