import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test('WeChat media encryption and transport work in the Cloudflare runtime', async () => {
  // workerd 直接执行源码，不编译；Node 单测无法捕获运行时兼容差异。
  await promisify(execFile)(process.execPath, [
    fileURLToPath(new URL('../node_modules/workerd/bin/workerd', import.meta.url)),
    'test', fileURLToPath(new URL('./workerd/media.capnp', import.meta.url))
  ], { timeout: 30000 });
});
