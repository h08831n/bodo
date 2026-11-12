import test from 'node:test';
import assert from 'node:assert/strict';
import {
  filterDrift,
  isAllowedNoiseIdentifier,
  ALLOWED_PARTITION_TABLE_REGEX,
} from '../check-drift-filter.mjs';

test('isAllowedNoiseIdentifier strictly validates identifiers with anchored regex', () => {
  // Valid partition tables
  assert.equal(isAllowedNoiseIdentifier('audit_logs_p202611'), true);
  assert.equal(isAllowedNoiseIdentifier('audit_logs_default'), true);
  assert.equal(isAllowedNoiseIdentifier('timeline_events_p202611'), true);
  assert.equal(isAllowedNoiseIdentifier('timeline_events_default'), true);
  assert.equal(isAllowedNoiseIdentifier('"public"."audit_logs_p202612"'), true);

  // Valid helper functions and extensions
  assert.equal(isAllowedNoiseIdentifier('ensure_monthly_partitions'), true);
  assert.equal(isAllowedNoiseIdentifier('ensure_monthly_partitions(text, int)'), true);
  assert.equal(isAllowedNoiseIdentifier('pg_trgm'), true);
  assert.equal(isAllowedNoiseIdentifier('unaccent'), true);

  // Disallowed: base tables themselves
  assert.equal(isAllowedNoiseIdentifier('audit_logs'), false);
  assert.equal(isAllowedNoiseIdentifier('timeline_events'), false);

  // Disallowed: similar names (must fail anchored regex)
  assert.equal(isAllowedNoiseIdentifier('audit_logs_backup'), false);
  assert.equal(isAllowedNoiseIdentifier('audit_logs_temp'), false);
  assert.equal(isAllowedNoiseIdentifier('timeline_events_archive'), false);
  assert.equal(isAllowedNoiseIdentifier('my_audit_logs_default'), false);
  assert.equal(isAllowedNoiseIdentifier('users'), false);
});

test('Condition (a): Allowed partition noise is ignored in diff', () => {
  const allowedSqlDiff = `
-- DropTable
DROP TABLE "audit_logs_p202611";

-- DropTable
DROP TABLE "audit_logs_default";

-- DropTable
DROP TABLE "timeline_events_p202611";

-- DropTable
DROP TABLE "timeline_events_default";

-- DropIndex
DROP INDEX "audit_logs_p202611_action_idx";

-- DropFunction
DROP FUNCTION "ensure_monthly_partitions";
`;

  const result = filterDrift(allowedSqlDiff);
  assert.equal(result.isClean, true);
  assert.equal(result.unexpectedDiffs.length, 0);

  // Human readable format
  const allowedHumanDiff = `
[-] Dropped table "audit_logs_p202611"
[-] Dropped table "audit_logs_default"
[-] Dropped table "timeline_events_p202611"
[-] Dropped table "timeline_events_default"
[-] Dropped index "audit_logs_p202611_action_idx"
`;
  const humanResult = filterDrift(allowedHumanDiff);
  assert.equal(humanResult.isClean, true);
  assert.equal(humanResult.unexpectedDiffs.length, 0);
});

test('Condition (b): Column/type/index change on audit_logs itself FAILS', () => {
  const diffOnAuditLogs = `
-- DropTable
DROP TABLE "audit_logs_default";

-- AlterTable
ALTER TABLE "audit_logs" DROP COLUMN "user_id";
`;

  const result = filterDrift(diffOnAuditLogs);
  assert.equal(result.isClean, false);
  assert.equal(result.unexpectedDiffs.length, 1);
  assert.match(result.unexpectedDiffs[0], /ALTER TABLE "audit_logs"/);
});

test('Condition (c): Table with similar name (audit_logs_backup) FAILS', () => {
  const diffWithSimilarName = `
-- DropTable
DROP TABLE "audit_logs_backup";

-- DropTable
DROP TABLE "audit_logs_p202611";
`;

  const result = filterDrift(diffWithSimilarName);
  assert.equal(result.isClean, false);
  assert.equal(result.unexpectedDiffs.length, 1);
  assert.match(result.unexpectedDiffs[0], /audit_logs_backup/);
});

test('Condition (d): Any business table change FAILS', () => {
  const diffWithBusinessTable = `
-- AlterTable
ALTER TABLE "users" ADD COLUMN "nickname" TEXT;

-- CreateTable
CREATE TABLE "customers" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL
);
`;

  const result = filterDrift(diffWithBusinessTable);
  assert.equal(result.isClean, false);
  assert.equal(result.unexpectedDiffs.length, 2);
  assert.match(result.unexpectedDiffs[0], /ALTER TABLE "users"/);
  assert.match(result.unexpectedDiffs[1], /CREATE TABLE "customers"/);
});
