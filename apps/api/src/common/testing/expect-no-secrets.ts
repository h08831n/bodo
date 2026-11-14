const FORBIDDEN_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /authorization/i,
  /masterpassword/i,
  /adminpassword/i,
  /apikey/i,
  /privatekey/i,
];

const NATIONAL_ID_REGEX = /\b\d{10}\b/;
const CARD_NUMBER_REGEX = /\b\d{16}\b|\b(?:\d{4}[ -]){3}\d{4}\b/;
const HASH_REGEX = /\$argon2|\$2[aby]\$/;

/**
 * Asserts that a response or log payload does not leak sensitive information,
 * tokens, credentials, national IDs (10 digits), or bank card numbers (16 digits).
 */
export function expectNoSecrets(payload: unknown, path = 'root'): void {
  if (payload === null || payload === undefined) {
    return;
  }

  if (typeof payload === 'string') {
    if (HASH_REGEX.test(payload)) {
      throw new Error(`[LEAK DETECTED] Password hash found at ${path}: "${payload}"`);
    }
    if (NATIONAL_ID_REGEX.test(payload)) {
      throw new Error(
        `[LEAK DETECTED] Plaintext 10-digit National ID found at ${path}: "${payload}"`,
      );
    }
    if (CARD_NUMBER_REGEX.test(payload)) {
      throw new Error(
        `[LEAK DETECTED] Plaintext 16-digit Card Number found at ${path}: "${payload}"`,
      );
    }
    return;
  }

  if (Array.isArray(payload)) {
    payload.forEach((item, index) => expectNoSecrets(item, `${path}[${index}]`));
    return;
  }

  if (typeof payload === 'object') {
    for (const [key, value] of Object.entries(payload)) {
      const currentPath = `${path}.${key}`;

      // Check if key itself is sensitive and has a non-redacted value
      const isSensitiveKey = FORBIDDEN_KEY_PATTERNS.some((p) => p.test(key));
      if (isSensitiveKey) {
        if (value !== '[REDACTED]' && value !== undefined && value !== null) {
          throw new Error(
            `[LEAK DETECTED] Sensitive field "${key}" present at ${currentPath} with non-redacted value: "${String(value)}"`,
          );
        }
      }

      expectNoSecrets(value, currentPath);
    }
  }
}
