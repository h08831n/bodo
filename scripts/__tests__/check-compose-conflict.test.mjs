import test from 'node:test';
import assert from 'node:assert/strict';
import { detectComposeProjectConflict } from '../check-compose-conflict.mjs';

test('detectComposeProjectConflict: returns no conflict when no containers exist', () => {
  const result = detectComposeProjectConflict([], 'bodo');
  assert.equal(result.hasConflict, false);
  assert.equal(result.conflicts.length, 0);
});

test('detectComposeProjectConflict: returns no conflict when containers belong to same target project', () => {
  const containers = [
    { name: '/bodo-postgres', project: 'bodo' },
    { name: '/bodo-redis', project: 'bodo' },
    { name: '/bodo-postgres-dev', project: 'bodo-dev' },
  ];
  const result = detectComposeProjectConflict(containers, 'bodo');
  assert.equal(result.hasConflict, false);
});

test('detectComposeProjectConflict: detects collision when container belongs to old project (e.g. infra)', () => {
  const containers = [
    { name: '/bodo-postgres', project: 'infra' },
    { name: '/bodo-redis', project: 'infra' },
    { name: '/bodo-postgres-dev', project: 'bodo-dev' },
  ];
  const result = detectComposeProjectConflict(containers, 'bodo');
  assert.equal(result.hasConflict, true);
  assert.equal(result.conflicts.length, 2);
  assert.equal(result.conflicts[0].container, 'bodo-postgres');
  assert.equal(result.conflicts[0].currentProject, 'infra');
  assert.equal(result.conflicts[0].targetProject, 'bodo');
});

test('detectComposeProjectConflict: ignores unrelated containers', () => {
  const containers = [
    { name: '/some-other-app', project: 'other' },
    { name: '/bodo-postgres-dev', project: 'bodo-dev' },
  ];
  const result = detectComposeProjectConflict(containers, 'bodo');
  assert.equal(result.hasConflict, false);
});
