import { encodeCursor, decodeCursor } from '../cursor-codec';
import { parseSortString, buildKeysetWhere, paginate } from '../paginate';
import { BadRequestException } from '@nestjs/common';

describe('Pagination & CursorCodec', () => {
  describe('encodeCursor & decodeCursor', () => {
    it('correctly encodes and decodes cursor values', () => {
      const payload = { id: 'order_123', createdAt: '2026-11-14T10:00:00.000Z', amount: 1500 };
      const encoded = encodeCursor(payload);
      expect(typeof encoded).toBe('string');
      expect(encoded).toContain('.');

      const decoded = decodeCursor(encoded);
      expect(decoded).toEqual(payload);
    });

    it('rejects tampered cursor signatures', () => {
      const payload = { id: 'user_1' };
      const encoded = encodeCursor(payload);
      const [dataB64] = encoded.split('.');
      const tampered = `${dataB64}.tamperedSignatureABC123`;

      expect(() => decodeCursor(tampered)).toThrow(BadRequestException);
    });

    it('rejects malformed cursor strings', () => {
      expect(() => decodeCursor('invalid-cursor')).toThrow(BadRequestException);
      expect(() => decodeCursor('')).toThrow(BadRequestException);
    });
  });

  describe('parseSortString', () => {
    it('uses defaultSort and appends id tie-breaker', () => {
      const sort = parseSortString(undefined, undefined, [
        { field: 'createdAt', direction: 'desc' },
      ]);
      expect(sort).toEqual([
        { field: 'createdAt', direction: 'desc' },
        { field: 'id', direction: 'asc', nullable: false },
      ]);
    });

    it('parses valid sort string with multiple columns', () => {
      const sort = parseSortString('name:asc,createdAt:desc', {
        name: { nullable: false },
        createdAt: { nullable: false },
      });
      expect(sort).toEqual([
        { field: 'name', direction: 'asc', nullable: false },
        { field: 'createdAt', direction: 'desc', nullable: false },
        { field: 'id', direction: 'asc', nullable: false },
      ]);
    });

    it('throws error if user passes more than 3 sort fields', () => {
      expect(() =>
        parseSortString('f1:asc,f2:asc,f3:asc,f4:asc', {
          f1: {},
          f2: {},
          f3: {},
          f4: {},
        }),
      ).toThrow(BadRequestException);
    });

    it('throws error if user requests unallowed sort field', () => {
      expect(() =>
        parseSortString('secretField:asc', {
          allowedField: {},
        }),
      ).toThrow(BadRequestException);
    });
  });

  describe('buildKeysetWhere', () => {
    it('builds keyset where for single field with id tie-breaker', () => {
      const sort = [
        { field: 'createdAt', direction: 'asc' as const, nullable: false },
        { field: 'id', direction: 'asc' as const, nullable: false },
      ];
      const where = buildKeysetWhere({ createdAt: '2026-01-01', id: '10' }, sort);
      expect(where).toEqual({
        OR: [
          { createdAt: { gt: '2026-01-01' } },
          {
            createdAt: '2026-01-01',
            OR: [{ id: { gt: '10' } }],
          },
        ],
      });
    });

    it('builds keyset where for nullable field under NULLS LAST contract', () => {
      const sort = [
        { field: 'code', direction: 'asc' as const, nullable: true },
        { field: 'id', direction: 'asc' as const, nullable: false },
      ];
      const where = buildKeysetWhere({ code: 'ABC', id: '10' }, sort);
      expect(where).toEqual({
        OR: [
          { code: { gt: 'ABC' } },
          { code: null },
          {
            code: 'ABC',
            OR: [{ id: { gt: '10' } }],
          },
        ],
      });
    });
  });

  describe('paginate function', () => {
    it('paginates over items and returns nextCursor when limit exceeded', async () => {
      const mockItems = [
        { id: '1', name: 'Alpha' },
        { id: '2', name: 'Beta' },
        { id: '3', name: 'Gamma' },
      ];

      const mockModel = {
        findMany: async () => mockItems,
        count: async () => 10,
      };

      const result = await paginate({
        model: mockModel,
        query: { limit: 2, withTotal: true },
        defaultSort: [{ field: 'id', direction: 'asc' }],
      });

      expect(result.items.length).toBe(2);
      expect(result.items).toEqual([mockItems[0], mockItems[1]]);
      expect(result.totalCount).toBe(10);
      expect(result.nextCursor).toBeDefined();

      const decoded = decodeCursor(result.nextCursor!);
      expect(decoded.id).toBe('2');
    });
  });
});
