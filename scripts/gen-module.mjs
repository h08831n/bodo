import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

const rawName = process.argv[2];
if (!rawName) {
  console.error('Usage: node scripts/gen-module.mjs <ModuleName>');
  console.error('Example: pnpm gen:module products');
  process.exit(1);
}

// Convert input to casing variations
const clean = rawName.replace(/[^a-zA-Z0-9_-]/g, '');
const kebabCase = clean
  .replace(/([a-z])([A-Z])/g, '$1-$2')
  .replace(/[\s_]+/g, '-')
  .toLowerCase();

const pascalCase = kebabCase
  .split('-')
  .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
  .join('');

const camelCase = pascalCase.charAt(0).toLowerCase() + pascalCase.slice(1);

const templateDir = path.join(rootDir, 'apps', 'api', 'src', 'modules', '_template');
const targetDir = path.join(rootDir, 'apps', 'api', 'src', 'modules', kebabCase);

if (fs.existsSync(targetDir)) {
  console.error(`[ERROR] Module directory already exists: ${targetDir}`);
  process.exit(1);
}

fs.mkdirSync(targetDir, { recursive: true });

function copyAndTransform(source, target) {
  const stat = fs.statSync(source);
  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    for (const child of fs.readdirSync(source)) {
      copyAndTransform(path.join(source, child), path.join(target, child));
    }
  } else {
    let content = fs.readFileSync(source, 'utf8');
    content = content
      .replace(/Template/g, pascalCase)
      .replace(/template/g, camelCase)
      .replace(/v1\/templates/g, `v1/${kebabCase}`);

    // Adjust target file name if needed
    const targetFile = target
      .replace(/template/g, kebabCase)
      .replace(/Template/g, kebabCase);

    fs.writeFileSync(targetFile, content, 'utf8');
  }
}

copyAndTransform(templateDir, targetDir);
console.log(`[SUCCESS] Generated new module "${pascalCase}" at apps/api/src/modules/${kebabCase}`);
