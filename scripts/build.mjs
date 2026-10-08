// Zips ./extension into ./dist/threejs-scene-exporter-vX.Y.Z.zip (needs the `zip` CLI).
import { readFileSync, mkdirSync } from 'fs';
import { execSync } from 'child_process';
const v = JSON.parse(readFileSync('extension/manifest.json', 'utf8')).version;
mkdirSync('dist', { recursive: true });
const out = `../dist/threejs-scene-exporter-v${v}.zip`;
execSync(`cd extension && zip -qr ${out} .`, { stdio: 'inherit' });
console.log('Built dist/threejs-scene-exporter-v' + v + '.zip');
