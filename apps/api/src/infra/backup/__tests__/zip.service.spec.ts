import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import archiver from 'archiver';
import { ZipService, ZipSecurityError } from '../zip.service';
import { resetEnv } from '../../../config/env.config';

describe('ZipService & Archive Security', () => {
  let zipService: ZipService;
  let tempBaseDir: string;

  beforeEach(() => {
    zipService = new ZipService();
    tempBaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bodo-zip-test-'));
  });

  afterEach(() => {
    if (fs.existsSync(tempBaseDir)) {
      fs.rmSync(tempBaseDir, { recursive: true, force: true });
    }
  });

  it('creates and extracts a valid backup archive with SHA256 verification', async () => {
    const dumpFile = path.join(tempBaseDir, 'test.pgdump');
    fs.writeFileSync(dumpFile, 'DUMMY_POSTGRES_DUMP_CONTENT');

    const filestoreDir = path.join(tempBaseDir, 'test_filestore');
    fs.mkdirSync(filestoreDir, { recursive: true });
    fs.writeFileSync(path.join(filestoreDir, 'file1.pdf'), 'PDF_CONTENT');

    const zipDest = path.join(tempBaseDir, 'backup.zip');
    const manifest = {
      db_name: 'erp_test',
      schema_version: '20261111160000_init',
      applied_migrations: ['20261111160000_init'],
      app_version: '0.1.0',
      created_at: new Date().toISOString(),
    };

    const { totalBytes } = await zipService.createArchive({
      dumpFilePath: dumpFile,
      filestoreDirPath: filestoreDir,
      destinationZipPath: zipDest,
      manifest,
    });

    expect(totalBytes).toBeGreaterThan(0);
    expect(fs.existsSync(zipDest)).toBe(true);

    const extractDest = path.join(tempBaseDir, 'extracted');
    const result = await zipService.extractAndValidate(zipDest, extractDest);

    expect(result.manifest.db_name).toBe('erp_test');
    expect(fs.existsSync(result.dumpFilePath)).toBe(true);
    expect(fs.readFileSync(result.dumpFilePath, 'utf8')).toBe('DUMMY_POSTGRES_DUMP_CONTENT');
    expect(fs.existsSync(path.join(result.filestoreDirPath, 'file1.pdf'))).toBe(true);
  });

  it('rejects an archive with Zip Slip attempt (path traversal with ..)', async () => {
    const maliciousZip = path.join(tempBaseDir, 'slip.zip');

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(maliciousZip);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append('content', { name: '../../evil.txt' });
      archive.append('{}', { name: 'manifest.json' });
      archive.finalize();
    });

    const extractDest = path.join(tempBaseDir, 'extracted_slip');
    await expect(zipService.extractAndValidate(maliciousZip, extractDest)).rejects.toThrow(
      ZipSecurityError,
    );
  });

  it('rejects an archive with null byte in entry filename', async () => {
    const maliciousZip = path.join(tempBaseDir, 'nullbyte.zip');

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(maliciousZip);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append('content', { name: 'safe\0evil.txt' });
      archive.append('{}', { name: 'manifest.json' });
      archive.finalize();
    });

    const extractDest = path.join(tempBaseDir, 'extracted_null');
    await expect(zipService.extractAndValidate(maliciousZip, extractDest)).rejects.toThrow(
      /null byte/i,
    );
  });

  it('rejects an archive with drive letters or backslashes', async () => {
    const maliciousZip = path.join(tempBaseDir, 'drive.zip');

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(maliciousZip);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      archive.append('content', { name: 'safe_file.txt' });
      archive.append('{}', { name: 'manifest.json' });
      archive.finalize();
    });

    // Patch the central directory in binary to inject an absolute drive letter path
    const zipBuf = fs.readFileSync(maliciousZip);
    let idx = 0;
    while ((idx = zipBuf.indexOf('safe_file.txt', idx)) !== -1) {
      zipBuf.write('C:/evil.txt\0\0', idx);
      idx += 13;
    }
    fs.writeFileSync(maliciousZip, zipBuf);

    const extractDest = path.join(tempBaseDir, 'extracted_drive');
    await expect(zipService.extractAndValidate(maliciousZip, extractDest)).rejects.toThrow(
      ZipSecurityError,
    );
  });

  it('rejects an archive when SHA256 checksum mismatches', async () => {
    const corruptZip = path.join(tempBaseDir, 'mismatch.zip');

    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(corruptZip);
      const archive = archiver('zip');
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      const manifest = {
        db_name: 'erp_test',
        schema_version: '20261111160000_init',
        applied_migrations: [],
        app_version: '0.1.0',
        created_at: new Date().toISOString(),
        sha256: {
          dump: '0000000000000000000000000000000000000000000000000000000000000000',
        },
      };

      archive.append(JSON.stringify(manifest), { name: 'manifest.json' });
      archive.append('REAL_DUMP_CONTENT', { name: 'dump.pgdump' });
      archive.finalize();
    });

    const extractDest = path.join(tempBaseDir, 'extracted_mismatch');
    await expect(zipService.extractAndValidate(corruptZip, extractDest)).rejects.toThrow(
      /Checksum mismatch/,
    );
  });

  it('rejects archive when entry count exceeds MAX_RESTORE_ENTRIES limit', async () => {
    const originalLimit = process.env.MAX_RESTORE_ENTRIES;
    process.env.MAX_RESTORE_ENTRIES = '3';
    resetEnv();
    try {
      const excessZip = path.join(tempBaseDir, 'excess_entries.zip');
      await new Promise<void>((resolve, reject) => {
        const output = fs.createWriteStream(excessZip);
        const archive = archiver('zip');
        output.on('close', resolve);
        archive.on('error', reject);
        archive.pipe(output);

        archive.append('{}', { name: 'manifest.json' });
        archive.append('d1', { name: 'dump.pgdump' });
        archive.append('f1', { name: 'filestore/file1.txt' });
        archive.append('f2', { name: 'filestore/file2.txt' }); // 4th entry exceeds limit of 3
        archive.finalize();
      });

      const extractDest = path.join(tempBaseDir, 'extracted_excess');
      await expect(zipService.extractAndValidate(excessZip, extractDest)).rejects.toThrow(
        /more than maximum allowed entries/,
      );
    } finally {
      process.env.MAX_RESTORE_ENTRIES = originalLimit;
      resetEnv();
    }
  });

  it('allows high compression ratio for small/normal files under 100MB threshold', async () => {
    // Highly compressible repeating pattern (e.g. repeated zeros) under 100MB
    const repeatedZip = path.join(tempBaseDir, 'compressible_small.zip');
    await new Promise<void>((resolve, reject) => {
      const output = fs.createWriteStream(repeatedZip);
      const archive = archiver('zip', { zlib: { level: 9 } });
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);

      const buffer = Buffer.alloc(1024 * 50, 0); // 50KB of zeros compresses to ~100 bytes (ratio > 500:1)
      archive.append(buffer, { name: 'dump.pgdump' });
      archive.append(
        JSON.stringify({
          db_name: 'erp_test',
          schema_version: '1',
          applied_migrations: [],
          app_version: '0.1.0',
          created_at: new Date().toISOString(),
          sha256: {
            dump: crypto.createHash('sha256').update(buffer).digest('hex'),
          },
        }),
        { name: 'manifest.json' },
      );
      archive.finalize();
    });

    const extractDest = path.join(tempBaseDir, 'extracted_compressible');
    // Must succeed without throwing ZIP_BOMB_DETECTED because size < 100MB
    const res = await zipService.extractAndValidate(repeatedZip, extractDest);
    expect(res.manifest.db_name).toBe('erp_test');
    expect(fs.existsSync(res.dumpFilePath)).toBe(true);
  });
});
