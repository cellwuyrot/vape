import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const originKitRoot = path.join(projectRoot, 'src', 'components', 'originkit');

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(fullPath) : [fullPath];
  });
}

const files = walk(originKitRoot).filter((file) => /hero.?58/i.test(file) || /gauze.?blaze/i.test(file));
if (!files.length) {
  console.error('Hero 58 files were not found. Run scripts/install-originkit-hero58.ps1 first.');
  process.exitCode = 2;
} else {
  console.log(`Found ${files.length} likely Hero 58 / Gauze Blaze source files:`);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const exports = [...source.matchAll(/export\s+(?:default\s+)?(?:function|class|const|let|var)\s+([A-Za-z_$][\w$]*)/g)].map((match) => match[1]);
    const defaultExport = /export\s+default\b/.test(source);
    console.log(`\n${path.relative(projectRoot, file)}`);
    console.log(`  default export: ${defaultExport ? 'yes' : 'no'}`);
    console.log(`  named exports: ${exports.length ? exports.join(', ') : '(not detected by simple scan)'}`);
  }
  console.log('\nReview these files and connect the actual Hero 58 export to src/main.js. Do not guess the generated component API.');
}
