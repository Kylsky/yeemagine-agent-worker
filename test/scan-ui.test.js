import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';

const source = await readFile(new URL('../public/app.js', import.meta.url), 'utf8');
// 在隔离上下文里运行页面脚本，按顺序返回各接口的模拟响应；定时器立即执行，测试不必真的等待。
function page(responses) {
  const elements = new Map(), requests = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, { querySelector:() => ({}), removeAttribute() {}, replaceChildren() {} });
    return elements.get(id);
  };
  runInNewContext(source, {
    document:{ getElementById:element },
    window:{ location:{ assign() {} } },
    setTimeout:fn => { queueMicrotask(fn); return 0; },
    URL:{ createObjectURL:() => 'blob:qr', revokeObjectURL() {} },
    Blob:class {},
    fetch:async path => {
      requests.push(path);
      const queue = responses[path] || [];
      const [status, body] = queue.length > 1 ? queue.shift() : queue[0];
      return Response.json(body, { status });
    }
  });
  return { element, requests };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 20));

test('QR status polling keeps going after a temporary error and completes the connection', async () => {
  const p = page({
    '/api/status':[[200, { configured:true, loggedIn:true, connected:false, csrf:'token' }]],
    '/api/qr':[[200, { svg:'<svg/>' }]],
    '/api/scan':[[409, { error:'OPERATION_IN_PROGRESS' }], [502, { error:'NETWORK_CONNECTION_LOST' }], [200, { status:'confirmed' }]]
  });
  await settle();
  await p.element('qr-button').onclick();
  await settle();
  assert.equal(p.requests.filter(path => path === '/api/scan').length, 3);
  assert.equal(p.element('scan-status').textContent, '连接成功。');
});
test('an expired QR code stops polling instead of retrying forever', async () => {
  const p = page({
    '/api/status':[[200, { configured:true, loggedIn:true, connected:false, csrf:'token' }]],
    '/api/qr':[[200, { svg:'<svg/>' }]],
    '/api/scan':[[410, { error:'QR_EXPIRED' }]]
  });
  await settle();
  await p.element('qr-button').onclick();
  await settle();
  assert.equal(p.requests.filter(path => path === '/api/scan').length, 1);
  assert.match(p.element('message').textContent, /二维码已过期/);
});
