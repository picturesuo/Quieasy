// Builds the unpacked extension into dist/ and a zip of it into dist-zip/.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipDirectory } from './zip.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const zipDir = join(root, 'dist-zip');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

rmSync(dist, { recursive: true, force: true });
mkdirSync(join(dist, 'icons'), { recursive: true });

const common = { bundle: true, platform: 'browser', target: 'chrome140', legalComments: 'none', logLevel: 'warning' };
await build({ ...common, entryPoints: [join(root, 'src/background/index.ts')], outfile: join(dist, 'background.js'), format: 'esm' });
for (const [entry, out] of [
  ['src/content/index.ts', 'content.js'],
  ['src/popup/popup.ts', 'popup.js'],
  ['src/options/options.ts', 'options.js'],
]) {
  await build({ ...common, entryPoints: [join(root, entry)], outfile: join(dist, out), format: 'iife' });
}

const manifest = JSON.parse(readFileSync(join(root, 'src/manifest.json'), 'utf8'));
manifest.version = pkg.version;
// Shown on the extensions page so a loaded copy can be matched to the commit it was built from.
manifest.version_name = `${pkg.version} (${buildRevision()})`;
writeFileSync(join(dist, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
for (const [from, to] of [
  ['src/content/content.css', 'content.css'],
  ['src/popup/popup.html', 'popup.html'],
  ['src/popup/ui.css', 'ui.css'],
  ['src/options/options.html', 'options.html'],
]) {
  copyFileSync(join(root, from), join(dist, to));
}
for (const size of [16, 32, 48, 128]) copyFileSync(join(root, 'src/icons', `icon${size}.png`), join(dist, 'icons', `icon${size}.png`));

rmSync(zipDir, { recursive: true, force: true });
mkdirSync(zipDir);
const zipPath = join(zipDir, `quieasy-${pkg.version}.zip`);
writeFileSync(zipPath, zipDirectory(dist));
console.warn(`Built ${dist} and ${zipPath}`);

function buildRevision() {
  try {
    const commit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim();
    return dirty ? `${commit}-modified` : commit;
  } catch {
    return 'unknown build';
  }
}
