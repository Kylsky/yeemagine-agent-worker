import test from 'node:test';
import assert from 'node:assert/strict';
import { Fault } from '../src/http.js';
import { Connection } from '../src/connection.js';
import { Weixin } from '../src/weixin.js';

const env = { PLATFORM_BASE_URL:'https://platform.example', PUBLIC_BASE_URL:'https://worker.example', OAUTH_CLIENT_ID:'client', PLATFORM_USER_ID:'123', OAUTH_CLIENT_SECRET:'test-secret', CREDENTIAL_ENCRYPTION_KEY:'1'.repeat(64) };
class Memory {
  constructor() { this.value = { epoch:0, seen:[], refs:[] }; }
  read() { return structuredClone(this.value); }
  write(v) { this.value = structuredClone(v); }
  async alarm(at) { this.at = at; }
  async getAlarm() { return this.at; }
  async deleteAlarm() { this.at = null; }
}
function fixture() {
  const repo = new Memory(), c = new Connection(repo, env); c.initialize();
  c.patch({ oauth:c.box({ access_token:'access', refresh_token:'refresh', expiresAt:Date.now()+900000 }, 'oauth'),
    bot:c.box({ bot_token:'bot-secret', baseurl:'https://ilinkai.weixin.qq.com' }, 'bot'), ownerHash:c.hash('owner'),
    route:c.box({ toUserId:'owner', contextToken:'context-secret' }, 'route'), thread:'thread', identityAt:Date.now() });
  const sent = []; c.wx.send = async (_bot, _route, item) => { sent.push(item.text_item?.text); return {}; };
  return { c, repo, sent };
}
const message = (text, id) => ({ message_id:id, from_user_id:'owner', context_token:'context-secret', message_type:1, message_state:2, item_list:[{ type:1, text_item:{ text } }] });
// 真实长轮询会挂起一段时间才返回，测试用短延时模拟，才能覆盖“长轮询进行中”的分支。
const later = (value, ms = 50) => new Promise(resolve => setTimeout(() => resolve(value), ms));
const nextIn = repo => Math.round((repo.at - Date.now()) / 1000);
function session(c) {
  c.patch({ sessionHash:c.hash('browser'), sessionUntil:Date.now() + 60000 });
  return (path, body = {}) => new Request(env.PUBLIC_BASE_URL + path, { method:'POST', body:JSON.stringify(body),
    headers:{ Origin:env.PUBLIC_BASE_URL, Cookie:'__Host-session=browser', 'X-CSRF-Token':c.csrf('browser'), 'Content-Type':'application/json' } });
}

test('a result that can never be delivered is dropped with a notice and new messages still get answered', async () => {
  const {c, sent} = fixture(); c.patch({ run:{ id:'run', sent:0 } });
  c.wx.updates = () => later({ msgs:[message('/status', '1')], get_updates_buf:'next' });
  c.platform.api = async (_token, path) => { if (path.includes('/runs/')) throw new Fault('RESOURCE_NOT_FOUND', 404); return {}; };
  await c.alarm();
  assert.equal(c.read().run, null);
  assert.ok(sent.some(text => text.includes('发不出去')));
  assert.ok(sent.some(text => text.includes('微信已连接')));
  assert.equal(c.read().cursor, 'next');
});
test('only one WeChat long poll is ever in flight, even while progress checks fail', async () => {
  const {c} = fixture(); c.patch({ run:{ id:'run', sent:0 } });
  let open = 0, most = 0;
  c.wx.updates = () => { open++; most = Math.max(most, open); return later({ msgs:[], get_updates_buf:'' }).finally(() => { open--; }); };
  c.platform.api = async () => { throw new Fault('NETWORK_CONNECTION_LOST', 502); };
  for (let i = 0; i < 3; i++) await c.alarm();
  assert.equal(most, 1); assert.equal(open, 0);
});
test('a platform outage during the identity check does not stop WeChat polling', async () => {
  const {c} = fixture(); c.patch({ identityAt:0 });
  let polls = 0; c.wx.updates = async () => { polls++; return { msgs:[], get_updates_buf:'' }; };
  c.platform.api = async () => { throw new Fault('PLATFORM_IDENTITY_NETWORK_TIMEOUT', 502); };
  await c.alarm();
  assert.equal(polls, 1); assert.ok(c.read().oauth); assert.equal(c.read().error, 'PLATFORM_IDENTITY_NETWORK_TIMEOUT');
});
test('a read-only command that keeps failing is tried three times, answered, then skipped so later messages flow', async () => {
  const {c, sent} = fixture(); let submits = 0;
  c.wx.updates = async () => ({ msgs:[message('/balance', '1'), message('/status', '2')], get_updates_buf:'next' });
  c.platform.api = async (_token, path) => { if (path.endsWith('/balance')) { submits++; throw new Fault('server_error', 500); } return {}; };
  for (let i = 0; i < 3; i++) await c.alarm();
  assert.equal(submits, 3);
  assert.ok(sent.some(text => text.includes('没能处理')));
  assert.ok(sent.some(text => text.includes('微信已连接')));
  assert.equal(c.read().cursor, 'next');
  await c.alarm(); assert.equal(submits, 3);
});
test('polling failures back off like the official client: 2s, 2s, then 30s', async () => {
  const {c, repo} = fixture(); const delays = [];
  c.wx.updates = async () => { throw new Fault('NETWORK_CONNECTION_LOST', 502); };
  for (let i = 0; i < 6; i++) { await c.alarm(); delays.push(nextIn(repo)); }
  assert.deepEqual(delays, [2, 2, 30, 2, 2, 30]);
});
test('a reply that cannot be sent never runs the command twice', async () => {
  const {c} = fixture(); let cancels = 0;
  c.patch({ run:{ id:'run', sent:0, noticeHash:null } });
  c.wx.send = async () => { throw new Fault('WEIXIN_API_ERROR', 502); };
  c.wx.updates = async () => ({ msgs:[message('/cancel', '9')], get_updates_buf:'next' });
  c.platform.api = async (_token, path) => { if (path.endsWith('/cancel')) cancels++; return { status:'running' }; };
  for (let i = 0; i < 4; i++) await c.alarm();
  assert.equal(cancels, 1);
});
test('the long-poll timeout suggested by WeChat is used for the next poll', async () => {
  const {c} = fixture(); const timeouts = [];
  c.wx.updates = async (_bot, _cursor, timeout) => { timeouts.push(timeout); return { msgs:[], get_updates_buf:'b', longpolling_timeout_ms:25000 }; };
  await c.alarm(); await c.alarm();
  assert.deepEqual(timeouts, [35000, 25000]);
});
test('QR status checks skip the platform and are not blocked by another operation', async () => {
  const {c} = fixture(); const post = session(c);
  c.patch({ bot:null, identityAt:0, scan:c.box({ qrcode:'qr', baseurl:'https://ilinkai.weixin.qq.com', until:Date.now() + 60000 }, 'scan') });
  c.platform.api = async () => { throw new Error('platform must not be called while polling the QR code'); };
  c.wx.scan = async () => ({ status:'wait' });
  c.controlBusy = true;
  const response = await c.handle(post('/api/scan'));
  assert.equal(response.status, 200); assert.equal((await response.json()).status, 'wait');
});
test('a QR status long poll that times out or hits a network blip counts as still waiting', async () => {
  const scan = { baseurl:'https://ilinkai.weixin.qq.com', qrcode:'qr' };
  assert.deepEqual(await new Weixin(async () => { throw new DOMException('timed out', 'TimeoutError'); }).scan(scan), { status:'wait' });
  assert.deepEqual(await new Weixin(async () => { throw new Error('Network connection lost.'); }).scan(scan), { status:'wait' });
  await assert.rejects(new Weixin(async () => new Response('', { status:500 })).scan(scan), { code:'WEIXIN_QR_FAILED' });
});
test('an image too large for WeChat becomes a notice and the rest of the result still arrives', async () => {
  const {c, sent} = fixture(); c.patch({ run:{ id:'run', sent:0 } });
  c.platform.api = async (_token, path) => { if (path.includes('/resources/')) throw new Fault('BODY_TOO_LARGE', 413); return { status:'completed', finalText:'画好了', artifacts:[{ resourceId:'r1' }] }; };
  await c.deliverSafely(c.read().epoch);
  assert.deepEqual(sent, ['画好了', '有一张图片无法通过微信发送（BODY_TOO_LARGE），请到平台查看。']); assert.equal(c.read().run, null);
  assert.equal(c.read().diagnostics.deliveryError, 'BODY_TOO_LARGE');
});
test('giving up on a result tells the user which step failed and keeps the reason for diagnostics', async () => {
  const {c, sent} = fixture(); c.patch({ run:{ id:'run', sent:1, failures:4 } });
  c.platform.api = async () => ({ status:'completed', finalText:'画好了', artifacts:[{ resourceId:'r1' }] });
  c.wx.upload = async () => { throw new Fault('NETWORK_TIMEOUT', 502); };
  await c.deliverSafely(c.read().epoch);
  assert.deepEqual(sent, ['这次的结果暂时发不出去（NETWORK_TIMEOUT），请到平台查看。']);
  assert.equal(c.read().run, null); assert.equal(c.read().diagnostics.deliveryError, 'NETWORK_TIMEOUT');
});
test('WeChat CDN rejections are final, server errors are retried, and API errors carry the WeChat code', async () => {
  const bot = { baseurl:'https://ilinkai.weixin.qq.com', bot_token:'token' }, route = { toUserId:'owner', contextToken:'ctx' };
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(32)]);
  const weixin = cdnStatus => new Weixin(async url => String(url).includes('getuploadurl')
    ? Response.json({ ret:0, upload_param:'param' }) : new Response('', { status:cdnStatus }));
  await assert.rejects(weixin(403).upload(bot, route, png), { code:'MEDIA_UPLOAD_REJECTED_403', status:400 });
  await assert.rejects(weixin(503).upload(bot, route, png), { code:'MEDIA_UPLOAD_HTTP_503', status:502 });
  await assert.rejects(weixin(200).upload(bot, route, png), { code:'MEDIA_UPLOAD_NO_PARAM' });
  const failing = new Weixin(async () => Response.json({ ret:-2, errmsg:'bad' }));
  await assert.rejects(failing.send(bot, route, { type:1, text_item:{ text:'x' } }, 'id'), { code:'WEIXIN_API_ERROR_-2' });
});
test('a temporary delivery failure is retried later without losing the task', async () => {
  const {c, sent} = fixture(); c.patch({ run:{ id:'run', sent:0 } }); let fail = true;
  c.platform.api = async () => { if (fail) throw new Fault('NETWORK_CONNECTION_LOST', 502); return { status:'completed', finalText:'好了', artifacts:[] }; };
  await c.deliverSafely(c.read().epoch);
  assert.equal(c.read().run.failures, 1); assert.ok(c.read().run.retryAt > Date.now()); assert.equal(sent.length, 0);
  fail = false; c.patch({ run:{ ...c.read().run, retryAt:0 } });
  await c.deliverSafely(c.read().epoch);
  assert.deepEqual(sent, ['好了']); assert.equal(c.read().run, null);
});
test('revoking always clears local data, even when the platform cannot be reached', async () => {
  const {c} = fixture(); const post = session(c);
  c.platform.api = async () => { throw new Fault('PLATFORM_IDENTITY_NETWORK_TIMEOUT', 502); };
  c.platform.token = async () => { throw new Fault('PLATFORM_TOKEN_NETWORK_TIMEOUT', 502); };
  const response = await c.handle(post('/api/revoke'));
  assert.equal(response.status, 200); assert.equal((await response.json()).platformRevoked, false);
  assert.equal(c.read().oauth, undefined); assert.equal(c.read().bot, undefined);
});
