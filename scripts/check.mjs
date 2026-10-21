import { readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
for (const dir of ['src', 'public', 'scripts', 'test']) {
  for (const name of readdirSync(dir)) if (/\.(m?js)$/.test(name)) execFileSync(process.execPath, ['--check', `${dir}/${name}`], { stdio: 'inherit' });
}
const config = JSON.parse(readFileSync('wrangler.jsonc', 'utf8'));
if (config.observability.enabled || config.durable_objects.bindings.length !== 1) throw new Error('Invalid privacy/deployment config');
console.log('源码语法与部署约束检查通过（未编译）。');
