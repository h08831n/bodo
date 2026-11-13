#!/usr/bin/env node
/**
 * scripts/check-compose-conflict.mjs
 *
 * Detects container name collisions when Docker Compose project name changes (e.g. from default 'infra' to 'bodo').
 * Prevents Docker Compose from failing with cryptic collision errors and guides the operator to safely run
 * `docker compose -p <old_project> down` without touching database volumes.
 */

import { spawnSync } from 'node:child_process';

export const DEFAULT_PRODUCTION_CONTAINERS = [
  'bodo-postgres',
  'bodo-redis',
  'bodo-api',
  'bodo-worker',
  'bodo-web',
];

/**
 * Pure function to inspect container list and detect project mismatch.
 *
 * @param {Array<{ name: string, project?: string }>} containers
 * @param {string} targetProject
 * @param {string[]} targetContainers
 * @returns {{ hasConflict: boolean, conflicts: Array<{ container: string, currentProject: string, targetProject: string }> }}
 */
export function detectComposeProjectConflict(
  containers,
  targetProject = 'bodo',
  targetContainers = DEFAULT_PRODUCTION_CONTAINERS,
) {
  const targetSet = new Set(targetContainers.map((c) => c.replace(/^\//, '')));
  const conflicts = [];

  for (const item of containers) {
    const cleanName = item.name.replace(/^\//, '');
    if (targetSet.has(cleanName)) {
      if (item.project && item.project !== targetProject) {
        conflicts.push({
          container: cleanName,
          currentProject: item.project,
          targetProject,
        });
      }
    }
  }

  return {
    hasConflict: conflicts.length > 0,
    conflicts,
  };
}

/**
 * Reads existing containers using `docker ps -a` and `docker inspect`.
 */
export function getDockerContainers() {
  if (process.env.BODO_MOCK_CONTAINERS) {
    const raw = process.env.BODO_MOCK_CONTAINERS.trim();
    if (raw.startsWith('[') || raw.startsWith('{')) {
      try {
        return JSON.parse(raw);
      } catch {
        // Fall back to simple key:value parsing
      }
    }
    return raw.split(',').map((pair) => {
      const [name, project] = pair.split(':');
      return { name: name.trim(), project: project ? project.trim() : undefined };
    });
  }

  const ps = spawnSync(
    'docker',
    ['ps', '-a', '--filter', 'name=bodo-', '--format', '{{.Names}}'],
    {
      encoding: 'utf8',
      shell: false,
    },
  );

  if (ps.status !== 0 || !ps.stdout) {
    return [];
  }

  const names = ps.stdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (names.length === 0) {
    return [];
  }

  const inspect = spawnSync('docker', ['inspect', ...names], {
    encoding: 'utf8',
    shell: false,
  });

  if (inspect.status !== 0 || !inspect.stdout) {
    return [];
  }

  try {
    const data = JSON.parse(inspect.stdout);
    return data.map((c) => ({
      name: c.Name,
      project: c.Config?.Labels?.['com.docker.compose.project'],
    }));
  } catch {
    return [];
  }
}

// CLI Execution
if (process.argv[1] && process.argv[1].endsWith('check-compose-conflict.mjs')) {
  const targetProject = process.argv[2] || 'bodo';
  const containers = getDockerContainers();
  const result = detectComposeProjectConflict(containers, targetProject);

  if (result.hasConflict) {
    const firstConflict = result.conflicts[0];
    const oldProject = firstConflict.currentProject;

    console.error('');
    console.error('======================================================================');
    console.error(' [ERROR] Docker Compose project name collision detected!');
    console.error('======================================================================');
    console.error(
      ` Existing container "${firstConflict.container}" belongs to compose project "${oldProject}"`,
    );
    console.error(` instead of target project "${targetProject}".`);
    console.error('');
    console.error(' This happens when containers were previously created under another project');
    console.error(' name (e.g. before "name: bodo" was configured in docker-compose.yml).');
    console.error('');
    console.error(' To resolve safely WITHOUT losing database volumes or data:');
    console.error(`   docker compose -p ${oldProject} down`);
    console.error('');
    console.error(' (DO NOT add -v / --volumes to preserve your existing database data!)');
    console.error('======================================================================');
    console.error('');
    process.exit(1);
  }

  process.exit(0);
}
