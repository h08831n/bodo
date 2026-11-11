import { describe, it, expect } from 'vitest';
import { truncateText } from '../index.js';

describe('Utils Truncate Helper', () => {
  it('does not truncate text shorter than maxLength', () => {
    expect(truncateText('سامانه bodo', 20)).toBe('سامانه bodo');
  });

  it('truncates text exceeding maxLength with ellipsis', () => {
    expect(truncateText('سامانه جامع مدیریت آهن‌آلات', 12)).toBe('سامانه جامع ...');
  });
});
