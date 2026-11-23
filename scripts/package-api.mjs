// Builds a self-contained Azure Functions deployment folder at ./api-package:
// compiled API + host.json + production node_modules, with @mileage/shared vendored in
// (Functions can't resolve npm workspace symlinks).
import { execSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const out = join(root, 'api-package');
const run = (cmd, cwd = root) => execSync(cmd, { cwd, stdio: 'inherit' });

run('npm run build -w @mileage/shared');
run('npm run build -w @mileage/api');

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
cpSync(join(root, 'api/dist'), join(out, 'dist'), { recursive: true });
cpSync(join(root, 'api/host.json'), join(out, 'host.json'));

const shared = JSON.parse(readFileSync(join(root, 'packages/shared/package.json'), 'utf8'));
const vendor = join(out, 'vendor/shared');
cpSync(join(root, 'packages/shared/dist'), join(vendor, 'dist'), { recursive: true });
writeFileSync(
  join(vendor, 'package.json'),
  JSON.stringify({ ...shared, scripts: undefined, devDependencies: undefined }, null, 2),
);

const api = JSON.parse(readFileSync(join(root, 'api/package.json'), 'utf8'));
api.dependencies['@mileage/shared'] = 'file:./vendor/shared';
delete api.devDependencies;
delete api.scripts;
writeFileSync(join(out, 'package.json'), JSON.stringify(api, null, 2));

run('npm install --omit=dev --install-links --no-audit --no-fund', out);
console.log(`\nPackaged API at ${out}`);
