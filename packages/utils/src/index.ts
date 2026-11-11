/**
 * Shared utility functions for bodo ERP.
 * Detailed Jalali, Iranian validators, and Money utils will be implemented in Step S1.10.
 */

export function truncateText(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}
