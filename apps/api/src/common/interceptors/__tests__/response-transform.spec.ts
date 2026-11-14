import { transformResponseValue } from '../response-transform.interceptor';
import { expectNoSecrets } from '../../testing/expect-no-secrets';

describe('ResponseTransform & Secret Redaction', () => {
  it('serializes Date to ISO-8601 UTC string', () => {
    const d = new Date('2026-11-14T10:00:00.000Z');
    const transformed = transformResponseValue({ createdAt: d }) as { createdAt: string };
    expect(transformed.createdAt).toBe('2026-11-14T10:00:00.000Z');
  });

  it('serializes BigInt to string', () => {
    const big = BigInt('9007199254740991000');
    const transformed = transformResponseValue({ amount: big }) as { amount: string };
    expect(transformed.amount).toBe('9007199254740991000');
  });

  it('serializes Decimal-like objects to string', () => {
    const decimalLike = {
      d: [123, 45],
      toString: () => '123.45',
    };
    const transformed = transformResponseValue({ price: decimalLike }) as { price: string };
    expect(transformed.price).toBe('123.45');
  });

  it('strips undefined properties from object responses', () => {
    const transformed = transformResponseValue({
      visible: 'yes',
      hidden: undefined,
      nested: { keep: 1, remove: undefined },
    }) as { visible: string; hidden?: string; nested: { keep: number; remove?: number } };

    expect(transformed).toEqual({
      visible: 'yes',
      nested: { keep: 1 },
    });
    expect('hidden' in transformed).toBe(false);
    expect('remove' in transformed.nested).toBe(false);
  });

  describe('expectNoSecrets', () => {
    it('passes for clean payloads', () => {
      const payload = {
        id: '123',
        name: 'Iron Rebar',
        price: '500000',
        createdAt: '2026-11-14T10:00:00.000Z',
      };
      expect(() => expectNoSecrets(payload)).not.toThrow();
    });

    it('throws error when sensitive key contains non-redacted secret', () => {
      const payload = {
        user: {
          username: 'hossein',
          password: 'plainTextPassword123',
        },
      };
      expect(() => expectNoSecrets(payload)).toThrow(/LEAK DETECTED/);
    });

    it('passes when sensitive key is [REDACTED]', () => {
      const payload = {
        user: {
          username: 'hossein',
          password: '[REDACTED]',
        },
      };
      expect(() => expectNoSecrets(payload)).not.toThrow();
    });

    it('throws error when 10-digit national ID is detected in string value', () => {
      const payload = {
        description: 'Customer national id is 0012345678 for registration',
      };
      expect(() => expectNoSecrets(payload)).toThrow(/National ID/);
    });

    it('throws error when 16-digit card number is detected in string value', () => {
      const payload = {
        notes: 'Deposit to card 6037-9918-1234-5678',
      };
      expect(() => expectNoSecrets(payload)).toThrow(/Card Number/);
    });
  });
});
