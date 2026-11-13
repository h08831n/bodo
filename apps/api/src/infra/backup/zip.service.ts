import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import archiver from 'archiver';
import yauzl from 'yauzl';
import { getEnv } from '../../config/env.config';

export interface BackupManifest {
  db_name: string;
  schema_version: string | null;
  applied_migrations: string[];
  app_version: string;
  created_at: string;
  sha256?: {
    dump?: string;
    manifest?: string;
  };
}

export interface CreateZipOptions {
  dumpFilePath: string;
  filestoreDirPath?: string;
  destinationZipPath: string;
  manifest: BackupManifest;
}

export interface ExtractedBackup {
  tempDir: string;
  dumpFilePath: string;
  filestoreDirPath: string;
  manifest: BackupManifest;
}

export class ZipSecurityError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'ZipSecurityError';
  }
}

export class ZipService {
  /**
   * Creates a backup zip archive with zip64 and maximum compression
   */
  async createArchive(options: CreateZipOptions): Promise<{ totalBytes: number }> {
    const parentDir = path.dirname(options.destinationZipPath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    // 1. Calculate SHA256 of the dump file
    const dumpHash = await this.calculateFileSha256(options.dumpFilePath);
    const manifestWithHash: BackupManifest = {
      ...options.manifest,
      sha256: {
        dump: dumpHash,
      },
    };

    return new Promise((resolve, reject) => {
      const output = fs.createWriteStream(options.destinationZipPath);
      const archive = archiver('zip', {
        zlib: { level: 9 },
        forceZip64: true,
      });

      output.on('close', () => {
        resolve({ totalBytes: archive.pointer() });
      });

      archive.on('error', (err: unknown) => {
        reject(err);
      });

      archive.pipe(output);

      // Append dump file
      archive.file(options.dumpFilePath, { name: 'dump.pgdump' });

      // Append manifest
      const manifestBuffer = Buffer.from(JSON.stringify(manifestWithHash, null, 2), 'utf8');
      archive.append(manifestBuffer, { name: 'manifest.json' });

      // Append filestore directory if exists
      if (options.filestoreDirPath && fs.existsSync(options.filestoreDirPath)) {
        archive.directory(options.filestoreDirPath, 'filestore');
      }

      archive.finalize().catch(reject);
    });
  }

  /**
   * Extracts and strictly validates a backup zip file against Zip-Slip, Zip-Bomb,
   * path traversal, null bytes, absolute paths, and symlinks.
   */
  async extractAndValidate(
    zipFilePath: string,
    destDir: string,
    options?: { maxEntries?: number; maxUncompressedBytes?: number },
  ): Promise<ExtractedBackup> {
    const env = getEnv();
    const maxEntries = options?.maxEntries ?? env.MAX_RESTORE_ENTRIES;
    const maxUncompressedBytes =
      options?.maxUncompressedBytes ?? env.MAX_RESTORE_UNCOMPRESSED_MB * 1024 * 1024;
    const normalizedDest = path.resolve(destDir);
    const destPrefix = normalizedDest + path.sep;

    if (!fs.existsSync(normalizedDest)) {
      fs.mkdirSync(normalizedDest, { recursive: true });
    }

    const zipfile = await new Promise<yauzl.ZipFile>((resolve, reject) => {
      yauzl.open(zipFilePath, { lazyEntries: true, autoClose: true }, (err, zf) => {
        if (err || !zf) {
          reject(
            new ZipSecurityError(
              `Failed to open zip archive: ${err?.message || 'Unknown error'}`,
              'CORRUPTED_ARCHIVE',
            ),
          );
        } else {
          resolve(zf);
        }
      });
    });

    let entryCount = 0;
    let totalUncompressedBytes = 0;
    let manifestBuffer: Buffer | null = null;

    try {
      await new Promise<void>((resolve, reject) => {
        zipfile.on('error', (err) => {
          reject(new ZipSecurityError(`Zip reading error: ${err.message}`, 'CORRUPTED_ARCHIVE'));
        });

        zipfile.on('end', () => {
          resolve();
        });

        zipfile.on('entry', async (entry: yauzl.Entry) => {
          entryCount++;

          // 1. Guard against entry flood (Zip Bomb)
          if (entryCount > maxEntries) {
            zipfile.close();
            return reject(
              new ZipSecurityError(
                `Zip archive contains more than maximum allowed entries (${maxEntries})`,
                'ZIP_BOMB_DETECTED',
              ),
            );
          }

          const rawName = entry.fileName;

          // 2. Strict character and format validation
          if (rawName.includes('\0')) {
            zipfile.close();
            return reject(
              new ZipSecurityError('Zip entry contains illegal null byte', 'ZIP_SLIP_ATTEMPT'),
            );
          }

          if (rawName.includes('\\')) {
            zipfile.close();
            return reject(
              new ZipSecurityError(
                'Zip entry contains backslash path separators',
                'ZIP_SLIP_ATTEMPT',
              ),
            );
          }

          if (/^[a-zA-Z]:/.test(rawName)) {
            zipfile.close();
            return reject(
              new ZipSecurityError('Zip entry contains drive letter prefix', 'ZIP_SLIP_ATTEMPT'),
            );
          }

          if (path.isAbsolute(rawName)) {
            zipfile.close();
            return reject(
              new ZipSecurityError('Zip entry contains absolute path', 'ZIP_SLIP_ATTEMPT'),
            );
          }

          // 3. Zip Slip path resolution test
          const targetPath = path.resolve(normalizedDest, rawName);
          if (targetPath !== normalizedDest && !targetPath.startsWith(destPrefix)) {
            zipfile.close();
            return reject(
              new ZipSecurityError(
                `Zip Slip attempt: "${rawName}" resolves outside destination`,
                'ZIP_SLIP_ATTEMPT',
              ),
            );
          }

          // 4. Reject Symlinks
          const mode = (entry.externalFileAttributes >> 16) & 0xffff;
          const isSymlink = (mode & 0o170000) === 0o120000;
          if (isSymlink) {
            zipfile.close();
            return reject(
              new ZipSecurityError(
                `Zip entry "${rawName}" is a symlink, which is strictly prohibited`,
                'ZIP_SLIP_ATTEMPT',
              ),
            );
          }

          // 5. Check size and compression ratio (Zip Bomb)
          totalUncompressedBytes += entry.uncompressedSize;
          if (totalUncompressedBytes > maxUncompressedBytes) {
            zipfile.close();
            return reject(
              new ZipSecurityError(
                `Zip uncompressed content exceeds size limit (${env.MAX_RESTORE_UNCOMPRESSED_MB}MB)`,
                'ZIP_BOMB_DETECTED',
              ),
            );
          }

          if (entry.compressedSize > 0) {
            const ratio = entry.uncompressedSize / entry.compressedSize;
            // Only apply compression ratio check when the entry itself is at least 100MB
            // to allow legitimately highly compressible empty tables / text dumps under 100MB
            const MIN_ENTRY_SIZE_FOR_RATIO_CHECK = 100 * 1024 * 1024; // 100MB
            if (ratio > 100 && entry.uncompressedSize >= MIN_ENTRY_SIZE_FOR_RATIO_CHECK) {
              zipfile.close();
              return reject(
                new ZipSecurityError(
                  `Zip entry "${rawName}" has suspicious compression ratio (${ratio.toFixed(1)}:1)`,
                  'ZIP_BOMB_DETECTED',
                ),
              );
            }
          }

          // 6. Extract directory or file
          const isDir = /\/$/.test(rawName);
          if (isDir) {
            fs.mkdirSync(targetPath, { recursive: true });
            zipfile.readEntry();
          } else {
            const parent = path.dirname(targetPath);
            if (!fs.existsSync(parent)) {
              fs.mkdirSync(parent, { recursive: true });
            }

            zipfile.openReadStream(entry, (err, readStream) => {
              if (err || !readStream) {
                zipfile.close();
                return reject(
                  new ZipSecurityError(
                    `Failed to read zip entry "${rawName}": ${err?.message}`,
                    'CORRUPTED_ARCHIVE',
                  ),
                );
              }

              // Special handling for manifest.json: keep buffer for parsing
              if (rawName === 'manifest.json') {
                const chunks: Buffer[] = [];
                readStream.on('data', (c) => chunks.push(c));
                readStream.on('end', () => {
                  manifestBuffer = Buffer.concat(chunks);
                  fs.writeFileSync(targetPath, manifestBuffer);
                  zipfile.readEntry();
                });
                readStream.on('error', (streamErr) => {
                  zipfile.close();
                  reject(streamErr);
                });
              } else {
                const writeStream = fs.createWriteStream(targetPath);
                pipeline(readStream, writeStream)
                  .then(() => {
                    zipfile.readEntry();
                  })
                  .catch((streamErr) => {
                    zipfile.close();
                    reject(streamErr);
                  });
              }
            });
          }
        });

        // Trigger first entry
        zipfile.readEntry();
      });
    } catch (err) {
      // Clean up extracted files on error
      if (fs.existsSync(normalizedDest)) {
        fs.rmSync(normalizedDest, { recursive: true, force: true });
      }
      throw err;
    }

    if (!manifestBuffer) {
      if (fs.existsSync(normalizedDest)) {
        fs.rmSync(normalizedDest, { recursive: true, force: true });
      }
      throw new ZipSecurityError(
        'Zip archive is missing required "manifest.json"',
        'CORRUPTED_ARCHIVE',
      );
    }

    let manifest: BackupManifest;
    try {
      manifest = JSON.parse((manifestBuffer as Buffer).toString('utf8'));
    } catch {
      if (fs.existsSync(normalizedDest)) {
        fs.rmSync(normalizedDest, { recursive: true, force: true });
      }
      throw new ZipSecurityError(
        'manifest.json in zip archive is not valid JSON',
        'CORRUPTED_ARCHIVE',
      );
    }

    const dumpFilePath = path.join(normalizedDest, 'dump.pgdump');
    if (!fs.existsSync(dumpFilePath)) {
      if (fs.existsSync(normalizedDest)) {
        fs.rmSync(normalizedDest, { recursive: true, force: true });
      }
      throw new ZipSecurityError(
        'Zip archive is missing required "dump.pgdump"',
        'CORRUPTED_ARCHIVE',
      );
    }

    // Verify SHA256 of dump if provided in manifest
    if (manifest.sha256?.dump) {
      const actualHash = await this.calculateFileSha256(dumpFilePath);
      if (actualHash !== manifest.sha256.dump) {
        if (fs.existsSync(normalizedDest)) {
          fs.rmSync(normalizedDest, { recursive: true, force: true });
        }
        throw new ZipSecurityError(
          `Checksum mismatch for dump.pgdump (expected: ${manifest.sha256.dump}, got: ${actualHash})`,
          'CORRUPTED_ARCHIVE',
        );
      }
    }

    const filestoreDirPath = path.join(normalizedDest, 'filestore');

    return {
      tempDir: normalizedDest,
      dumpFilePath,
      filestoreDirPath,
      manifest,
    };
  }

  private async calculateFileSha256(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const hash = crypto.createHash('sha256');
      const stream = fs.createReadStream(filePath);
      stream.on('data', (d) => hash.update(d));
      stream.on('end', () => resolve(hash.digest('hex')));
      stream.on('error', (err) => reject(err));
    });
  }
}
