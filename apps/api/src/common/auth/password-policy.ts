export interface PasswordPolicyResult {
  valid: boolean;
  error?: string;
}

const COMMON_PASSWORDS = new Set([
  '123456',
  'password',
  '12345678',
  '123456789',
  '12345',
  '1234567',
  'admin',
  '1234567890',
  'welcome',
  'qwerty',
  '111111',
  'bodo123',
  'bodo2026',
  'password123',
  'admin123',
  'root',
  'pass1234',
  'secret',
  'changeme',
  'password1234',
  'password1234!',
]);

export class PasswordPolicy {
  static readonly MIN_LENGTH = 10;
  static readonly MAX_LENGTH = 128;
  static readonly MAX_INPUT_BYTES = 1024;

  /**
   * Validates a password against bodo ERP password security policy:
   * 1. Anti-DoS raw byte length check (<= 1024 bytes)
   * 2. Unicode NFKC normalization
   * 3. Length bounds (10 to 128 characters)
   * 4. Does not equal username
   * 5. Not in common blacklist
   */
  static validate(rawPassword: string, rawUsername?: string): PasswordPolicyResult {
    if (!rawPassword) {
      return { valid: false, error: 'رمز عبور نمی‌تواند خالی باشد' };
    }

    // Anti-DoS check before expensive operations
    if (Buffer.byteLength(rawPassword, 'utf8') > this.MAX_INPUT_BYTES) {
      return { valid: false, error: 'طول ورودی رمز عبور بیش از حد مجاز است' };
    }

    // Unicode NFKC normalization
    const normalizedPassword = rawPassword.normalize('NFKC');

    if (normalizedPassword.length < this.MIN_LENGTH) {
      return {
        valid: false,
        error: `رمز عبور باید حداقل ${this.MIN_LENGTH} کاراکتر باشد`,
      };
    }

    if (normalizedPassword.length > this.MAX_LENGTH) {
      return {
        valid: false,
        error: `رمز عبور نمی‌تواند بیش از ${this.MAX_LENGTH} کاراکتر باشد`,
      };
    }

    if (rawUsername) {
      const normalizedUsername = rawUsername.trim().normalize('NFKC').toLowerCase();
      if (normalizedPassword.toLowerCase() === normalizedUsername) {
        return {
          valid: false,
          error: 'رمز عبور نمی‌تواند با نام کاربری برابر باشد',
        };
      }
    }

    if (COMMON_PASSWORDS.has(normalizedPassword.toLowerCase())) {
      return {
        valid: false,
        error: 'این رمز عبور بسیار رایج و ناامن است؛ لطفاً رمز قوی‌تری انتخاب کنید',
      };
    }

    return { valid: true };
  }

  /**
   * Normalizes username according to NFKC, lowercase, and trimmed.
   */
  static normalizeUsername(username: string): string {
    return username.trim().normalize('NFKC').toLowerCase();
  }
}
