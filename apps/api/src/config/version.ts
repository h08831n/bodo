import fs from 'node:fs';
import path from 'node:path';

function resolveVersionInfo() {
  const version = '0.1.0';
  let commit = process.env.GIT_COMMIT || 'dev';
  let buildTime = process.env.BUILD_TIME || new Date().toISOString();

  // Try reading version.json if created during build
  const versionFile = path.resolve(__dirname, '../../version.json');
  if (fs.existsSync(versionFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
      if (parsed.commit) commit = parsed.commit;
      if (parsed.buildTime) buildTime = parsed.buildTime;
    } catch {
      // Ignore reading error
    }
  }

  return {
    version,
    commit,
    buildTime,
  };
}

export const VERSION_INFO = resolveVersionInfo();
