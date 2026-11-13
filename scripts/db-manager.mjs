#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { loadRootEnv } from './db-env.mjs';

loadRootEnv();

async function resolveApiBase(specifiedUrl) {
  if (specifiedUrl) return specifiedUrl;
  if (process.env.API_URL) return process.env.API_URL;
  try {
    const res = await fetch('http://127.0.0.1:3000/health/live', { signal: AbortSignal.timeout(600) });
    if (res.ok) return 'http://127.0.0.1:3000';
  } catch {}
  try {
    const res = await fetch('http://127.0.0.1/health/live', { signal: AbortSignal.timeout(600) });
    if (res.ok) return 'http://127.0.0.1';
  } catch {}
  return `http://127.0.0.1:${process.env.PORT || 3000}`;
}

function printHelp() {
  console.log(`
Bodo Database Manager CLI

Usage:
  pnpm db:manager <command> [arguments...] [options]

Commands:
  list                          List all tenant databases
  create <name>                 Create a new tenant database
    [--user <username>]           Admin username (default: admin)
    [--name <fullName>]           Admin full name (default: مدیر سیستم)
    [--pass <password>]           Admin password (prompted if omitted)
    [--watch]                     Watch job progress until completed
  duplicate <source> <target>   Duplicate an existing tenant database
    [--pass <password>]           New admin password (prompted if omitted)
    [--watch]                     Watch job progress until completed
  backup <name>                 Create a backup of a tenant database
    [--watch]                     Watch job progress until completed
  backups <name>                List available backup archives for a tenant
  download <name> <file> <dest> Download a backup zip file to local destination
  restore <name> <zipfile>      Restore a tenant database from a backup zip file
    [--watch]                     Watch job progress until completed
  delete <name>                 Safely delete a tenant database (with automatic backup)
    [--confirm <name>]            Bypass interactive confirmation
    [--watch]                     Watch job progress until completed
  upgrade <name>                Apply pending schema migrations to a database
    [--watch]                     Watch job progress until completed
  repair <name>                 Repair migration state and unblock connections
    [--confirm]                   Confirm repair execution
  maintenance <name> <on|off>   Toggle maintenance mode manually
    [--reason <reason>]           Reason for maintenance
    [--confirm]                   Confirm clearing if state is migration_failed
  domain <name> [hostname]      Assign or clear (if omitted) domain mapping
  jobs [status]                 List BullMQ admin jobs (active, completed, failed, etc.)
  watch <jobId>                 Stream/poll progress of an ongoing background job

Options:
  --url <url>                   Base URL of the Bodo API (default: ${API_BASE})
  --help, -h                    Show this help message
`);
}

function promptSecure(promptText = 'Password: ') {
  const envMaster = process.env.MASTER_PASSWORD || process.env.MASTER_PASSWORD_INITIAL;
  if (envMaster && promptText.includes('Master')) {
    return Promise.resolve(envMaster);
  }
  return new Promise((resolve) => {
    if (!process.stdin.isTTY) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question(promptText, (ans) => {
        rl.close();
        resolve(ans.trim());
      });
      return;
    }

    process.stdout.write(promptText);
    const stdin = process.stdin;
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    let password = '';
    const onData = (ch) => {
      ch = ch.toString('utf8');
      if (ch === '\n' || ch === '\r' || ch === '\u0004') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        resolve(password);
      } else if (ch === '\u0003') {
        stdin.setRawMode(false);
        stdin.pause();
        stdin.removeListener('data', onData);
        process.stdout.write('\n');
        process.exit(130);
      } else if (ch === '\u0008' || ch === '\x7f') {
        if (password.length > 0) {
          password = password.slice(0, -1);
          process.stdout.write('\b \b');
        }
      } else {
        password += ch;
        process.stdout.write('*');
      }
    };
    stdin.on('data', onData);
  });
}

function promptText(promptText = '> ') {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(promptText, (ans) => {
      rl.close();
      resolve(ans.trim());
    });
  });
}

class AdminClient {
  constructor(baseUrl) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.token = null;
  }

  async login(password) {
    let res;
    try {
      res = await fetch(`${this.baseUrl}/v1/admin/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
    } catch (err) {
      throw new Error(`Could not connect to API server at ${this.baseUrl}: ${err.message}`);
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `Login failed with HTTP ${res.status}`);
    }

    this.token = data.token || data.accessToken;
    return this.token;
  }

  async request(method, pathUrl, body = null, isFormData = false) {
    if (!this.token) {
      throw new Error('Not authenticated. Master login required.');
    }

    const headers = {
      Authorization: `Bearer ${this.token}`,
    };

    let fetchBody = body;
    if (body && !isFormData) {
      headers['Content-Type'] = 'application/json';
      fetchBody = JSON.stringify(body);
    }

    const res = await fetch(`${this.baseUrl}${pathUrl}`, {
      method,
      headers,
      body: fetchBody,
    });

    const ct = res.headers.get('content-type') || '';
    if (ct.includes('application/octet-stream') || ct.includes('application/zip')) {
      return res;
    }

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.message || `Request to ${pathUrl} failed with HTTP ${res.status}`);
    }
    return data;
  }
}

async function watchJob(client, jobId) {
  process.stdout.write(`Watching job [${jobId}]...\n`);
  let lastProgress = -1;
  let lastStep = '';

  while (true) {
    let job;
    try {
      job = await client.request('GET', `/v1/admin/jobs/${jobId}`);
    } catch (err) {
      console.error(`\n[ERROR] Failed to fetch job status: ${err.message}`);
      break;
    }

    const progress = typeof job.progress === 'number' ? job.progress : job.progress?.percent || 0;
    const step = job.progress?.step || job.status;
    const msg = job.progress?.message || '';

    if (progress !== lastProgress || step !== lastStep) {
      process.stdout.write(`\r  [${progress}%] ${step}: ${msg}`.padEnd(70));
      lastProgress = progress;
      lastStep = step;
    }

    if (job.status === 'completed') {
      process.stdout.write(`\n✓ Job completed successfully!\n`);
      if (job.result) {
        console.log('Result:', JSON.stringify(job.result, null, 2));
      }
      break;
    }

    if (job.status === 'failed') {
      process.stdout.write(`\n✗ Job failed: ${job.error || 'Unknown error'}\n`);
      process.exitCode = 1;
      break;
    }

    await new Promise((r) => setTimeout(r, 600));
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printHelp();
    return;
  }

  let specifiedUrl = null;
  const urlIdx = args.indexOf('--url');
  if (urlIdx !== -1 && args[urlIdx + 1]) {
    specifiedUrl = args[urlIdx + 1];
    args.splice(urlIdx, 2);
  }
  const baseUrl = await resolveApiBase(specifiedUrl);

  const command = args[0];
  const commandArgs = args.slice(1);

  const client = new AdminClient(baseUrl);
  const masterPassword = await promptSecure('Master Password: ');
  if (!masterPassword) {
    console.error('Master password is required.');
    process.exit(1);
  }

  try {
    await client.login(masterPassword);
  } catch (err) {
    console.error(`[ERROR] Authentication failed: ${err.message}`);
    process.exit(1);
  }

  const hasWatch = commandArgs.includes('--watch');

  switch (command) {
    case 'list': {
      const list = await client.request('GET', '/v1/admin/databases');
      console.log('\n--- Tenant Databases ---');
      if (list.length === 0) {
        console.log('(No databases found)');
        break;
      }
      console.table(
        list.map((d) => ({
          Slug: d.slug,
          State: d.state,
          Schema: d.schemaVersion || 'none',
          Pending: d.pendingMigrations,
          Size: `${(d.sizeBytes / 1024 / 1024).toFixed(1)} MB`,
          Domain: d.domain || '-',
          'Last Backup': d.lastBackup ? new Date(d.lastBackup).toLocaleString() : '-',
        })),
      );
      break;
    }

    case 'create': {
      const name = commandArgs[0];
      if (!name || name.startsWith('--')) {
        console.error('Usage: pnpm db:manager create <name> [--user <username>] [--name <fullName>] [--pass <password>]');
        process.exit(1);
      }
      const userIdx = commandArgs.indexOf('--user');
      const nameIdx = commandArgs.indexOf('--name');
      const passIdx = commandArgs.indexOf('--pass');

      const adminUsername = userIdx !== -1 ? commandArgs[userIdx + 1] : 'admin';
      const adminFullName = nameIdx !== -1 ? commandArgs[nameIdx + 1] : 'مدیر سیستم';
      let adminPassword = passIdx !== -1 ? commandArgs[passIdx + 1] : null;

      if (!adminPassword) {
        adminPassword = await promptSecure(`Admin password for "${name}": `);
        if (!adminPassword) {
          console.error('Admin password is required.');
          process.exit(1);
        }
      }

      const res = await client.request('POST', '/v1/admin/databases', {
        name,
        adminUsername,
        adminFullName,
        adminPassword,
      });

      console.log(`Creation job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'duplicate': {
      const source = commandArgs[0];
      const target = commandArgs[1];
      if (!source || !target || source.startsWith('--') || target.startsWith('--')) {
        console.error('Usage: pnpm db:manager duplicate <source> <target> [--pass <admin_password>]');
        process.exit(1);
      }
      const passIdx = commandArgs.indexOf('--pass');
      let adminPassword = passIdx !== -1 ? commandArgs[passIdx + 1] : null;

      const res = await client.request('POST', `/v1/admin/databases/${source}/duplicate`, {
        newName: target,
        adminPassword: adminPassword || undefined,
      });

      console.log(`Duplication job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'backup': {
      const name = commandArgs[0];
      if (!name) {
        console.error('Usage: pnpm db:manager backup <name>');
        process.exit(1);
      }
      const res = await client.request('POST', `/v1/admin/databases/${name}/backups`);
      console.log(`Backup job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'backups': {
      const name = commandArgs[0];
      if (!name) {
        console.error('Usage: pnpm db:manager backups <name>');
        process.exit(1);
      }
      const backups = await client.request('GET', `/v1/admin/databases/${name}/backups`);
      console.log(`\n--- Backups for ${name} ---`);
      if (backups.length === 0) {
        console.log('(No backups found)');
        break;
      }
      console.table(
        backups.map((b) => ({
          Filename: b.file || b.filename,
          Size: `${(b.sizeBytes / 1024 / 1024).toFixed(2)} MB`,
          Schema: b.schemaVersion || 'unknown',
          'Created At': new Date(b.createdAt).toLocaleString(),
        })),
      );
      break;
    }

    case 'download': {
      const name = commandArgs[0];
      const filename = commandArgs[1];
      const dest = commandArgs[2];
      if (!name || !filename || !dest) {
        console.error('Usage: pnpm db:manager download <name> <filename> <destination_path>');
        process.exit(1);
      }
      const res = await client.request('GET', `/v1/admin/databases/${name}/backups/${filename}`);
      const arrayBuffer = await res.arrayBuffer();
      const destPath = path.resolve(dest);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, Buffer.from(arrayBuffer));
      console.log(`✓ Backup downloaded successfully to: ${destPath}`);
      break;
    }

    case 'restore': {
      const name = commandArgs[0];
      const zipPath = commandArgs[1];
      if (!name || !zipPath) {
        console.error('Usage: pnpm db:manager restore <name> <path_to_zip>');
        process.exit(1);
      }
      const resolvedZip = path.resolve(zipPath);
      if (!fs.existsSync(resolvedZip)) {
        console.error(`Backup file not found at: ${resolvedZip}`);
        process.exit(1);
      }

      console.log(`Uploading backup zip (${(fs.statSync(resolvedZip).size / 1024 / 1024).toFixed(2)} MB)...`);
      const fileBuffer = fs.readFileSync(resolvedZip);
      const blob = new Blob([fileBuffer], { type: 'application/zip' });
      const formData = new FormData();
      formData.append('file', blob, path.basename(resolvedZip));
      formData.append('newName', name);

      const res = await client.request('POST', '/v1/admin/databases/restore', formData, true);
      console.log(`Restore job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'delete': {
      const name = commandArgs[0];
      if (!name) {
        console.error('Usage: pnpm db:manager delete <name> [--confirm <name>]');
        process.exit(1);
      }
      const confirmIdx = commandArgs.indexOf('--confirm');
      let confirmName = confirmIdx !== -1 ? commandArgs[confirmIdx + 1] : null;

      if (!confirmName) {
        console.log(`\n[WARNING] Deleting "${name}" will terminate all connections, take an automatic backup, and DROP the database!`);
        confirmName = await promptText(`Type database name "${name}" to confirm: `);
      }

      const res = await client.request('DELETE', `/v1/admin/databases/${name}`, { confirmName });
      console.log(`Delete job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'upgrade': {
      const name = commandArgs[0];
      if (!name) {
        console.error('Usage: pnpm db:manager upgrade <name>');
        process.exit(1);
      }
      const res = await client.request('POST', `/v1/admin/databases/${name}/upgrade`);
      console.log(`Upgrade job queued. Job ID: ${res.jobId}`);
      if (hasWatch) {
        await watchJob(client, res.jobId);
      }
      break;
    }

    case 'repair': {
      const name = commandArgs[0];
      if (!name) {
        console.error('Usage: pnpm db:manager repair <name> [--confirm]');
        process.exit(1);
      }
      const isConfirmed = commandArgs.includes('--confirm');
      if (!isConfirmed) {
        const ans = await promptText(`Are you sure you want to run repair on "${name}"? (y/N): `);
        if (ans.toLowerCase() !== 'y') {
          console.log('Repair aborted.');
          return;
        }
      }
      const res = await client.request('POST', `/v1/admin/databases/${name}/repair`, {
        confirm: true,
      });
      console.log(`✓ ${res.message || 'Database repaired successfully.'}`);
      break;
    }

    case 'maintenance': {
      const name = commandArgs[0];
      const state = commandArgs[1]?.toLowerCase();
      if (!name || (state !== 'on' && state !== 'off')) {
        console.error('Usage: pnpm db:manager maintenance <name> <on|off> [--reason <reason>] [--confirm]');
        process.exit(1);
      }
      const reasonIdx = commandArgs.indexOf('--reason');
      const reason = reasonIdx !== -1 ? commandArgs[reasonIdx + 1] : 'manual';
      const confirm = commandArgs.includes('--confirm');

      await client.request('PUT', `/v1/admin/databases/${name}/maintenance`, {
        enabled: state === 'on',
        reason,
        confirm,
      });
      console.log(`✓ Maintenance mode for "${name}" set to: ${state}`);
      break;
    }

    case 'domain': {
      const name = commandArgs[0];
      const host = commandArgs[1] && !commandArgs[1].startsWith('--') ? commandArgs[1] : null;
      if (!name) {
        console.error('Usage: pnpm db:manager domain <name> [hostname]');
        process.exit(1);
      }
      await client.request('PUT', `/v1/admin/databases/${name}/domain`, {
        domain: host,
      });
      console.log(`✓ Domain for "${name}" updated to: ${host || '(none)'}`);
      break;
    }

    case 'jobs': {
      const status = commandArgs[0] && !commandArgs[0].startsWith('--') ? commandArgs[0] : '';
      const query = status ? `?status=${encodeURIComponent(status)}` : '';
      const jobs = await client.request('GET', `/v1/admin/jobs${query}`);
      console.log('\n--- Admin Background Jobs ---');
      if (jobs.length === 0) {
        console.log('(No jobs found)');
        break;
      }
      console.table(
        jobs.map((j) => ({
          ID: j.id,
          Type: j.type,
          Database: j.dbName,
          Status: j.status,
          Progress: `${typeof j.progress === 'number' ? j.progress : j.progress?.percent || 0}%`,
          Step: j.progress?.step || '-',
        })),
      );
      break;
    }

    case 'watch': {
      const jobId = commandArgs[0];
      if (!jobId) {
        console.error('Usage: pnpm db:manager watch <jobId>');
        process.exit(1);
      }
      await watchJob(client, jobId);
      break;
    }

    default:
      console.error(`Unknown command: "${command}". Use --help for available commands.`);
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`\n[FATAL] ${err.message}`);
  process.exit(1);
});
