import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { Connection } from '../src/connection.js';
import { State } from '../src/state.js';
import { Fault } from '../src/http.js';

const env = { PLATFORM_BASE_URL:'https://platform.example', PUBLIC_BASE_URL:'https://worker.example', OAUTH_CLIENT_ID:'client', PLATFORM_USER_ID:'123', OAUTH_CLIENT_SECRET:'test-secret', CREDENTIAL_ENCRYPTION_KEY:'1'.repeat(64) };
const message = (text, id = '1') => ({ message_id:id, from_user_id:'owner', context_token:'context', message_type:1, message_state:2, item_list:[{ type:1, text_item:{ text } }] });
function fixture(t, fetcher = async () => { throw new Error('Unexpected network request'); }) {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const repo = new State({ sql:{ exec(sql, ...args) {
    const statement = db.prepare(sql);
    if (statement.columns().length) return statement.all(...args);
    statement.run(...args); return [];
  } } });
  const sent = [];
  const restart = () => {
    const c = new Connection(repo, env, fetcher); c.initialize();
    c.wx.send = async (_bot, _route, item, id) => { sent.push({ item, id }); };
    return c;
  };
  const c = restart();
  c.patch({ oauth:c.box({ access_token:'access', refresh_token:'fixed-refresh', expiresAt:Date.now()+900000 }, 'oauth'),
    bot:c.box({ bot_token:'bot', baseurl:'https://ilinkai.weixin.qq.com' }, 'bot'), ownerHash:c.hash('owner'),
    route:c.box({ toUserId:'owner', contextToken:'context' }, 'route'), thread:'thread', identityAt:Date.now(),
    run:{ id:'original-run', sent:0, noticeHash:null } });
  return { c, repo, sent, restart };
}
const ready = c => c.patch({ run:{ ...c.read().run, retryAt:0 } });

test('交接期间只轮询原 runId，实例恢复不发中间摘要、不重新创建任务', async t => {
  const paths = []; let polls = 0;
  const f = fixture(t, async (url, init) => {
    paths.push(new URL(url).pathname); assert.equal(init.method, 'GET');
    return Response.json(++polls <= 8 ? { status:'running', finalText:'内部交接摘要', artifacts:[{ resourceId:'not-final' }] }
      : { status:'completed', finalText:'完成全部工作', artifacts:[] });
  });
  let c = f.c;
  for (let i = 0; i < 8; i++) {
    await c.deliverSafely(c.read().epoch); c = f.restart();
    assert.equal(c.read().run.id, 'original-run'); assert.equal(f.sent.length, 0);
  }
  await c.deliverSafely(c.read().epoch); await c.deliverSafely(c.read().epoch);
  assert.equal(paths.length, 9); assert.ok(paths.every(path => path === '/v1/agent/runs/original-run'));
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].item.text_item.text, '完成全部工作');
  assert.equal(c.read().run, null);
});

test('平台暂停、刷新服务故障和限流超过五次仍保留任务，成功查询清零连续失败', async t => {
  let code = 'OAUTH_DISABLED', status = 503, paused = true;
  const { c, sent } = fixture(t, async () => paused ? Response.json({ code }, { status }) : Response.json({ status:'running' }));
  for (const failure of [['OAUTH_DISABLED',503], ['server_error',502], ['rate_limited',429], ['INVALID_JSON',400], ['BODY_TOO_LARGE',413], ['invalid_client',401]]) {
    [code,status] = failure;
    for (let i = 0; i < 7; i++) { ready(c); await c.deliverSafely(c.read().epoch); assert.equal(c.read().run.id, 'original-run'); }
  }
  assert.equal(sent.length, 0); assert.ok(c.read().oauth);
  paused = false; ready(c); await c.deliverSafely(c.read().epoch);
  assert.equal(c.read().run.failures, 0);
});

test('长任务令牌刷新暂时失败不丢 runId，恢复保留固定 refresh token', async t => {
  let failed = true, refreshes = 0;
  const { c, sent } = fixture(t, async (url, init) => {
    if (new URL(url).pathname === '/oauth/token') {
      assert.equal(new URLSearchParams(init.body).get('refresh_token'), 'fixed-refresh'); refreshes++;
      return failed ? Response.json({ code:'server_error' }, { status:503 }) : Response.json({ access_token:'new', expires_in:900 });
    }
    assert.equal(init.headers.Authorization, 'Bearer new');
    return Response.json({ status:'completed', finalText:'继续完成' });
  });
  c.patch({ oauth:c.box({ access_token:'old', refresh_token:'fixed-refresh', expiresAt:0 }, 'oauth') });
  for (let i = 0; i < 6; i++) { ready(c); await c.deliverSafely(c.read().epoch); assert.equal(c.read().run.id, 'original-run'); }
  failed = false; ready(c); await c.deliverSafely(c.read().epoch);
  assert.equal(refreshes, 7); assert.equal(c.open(c.read().oauth, 'oauth').refresh_token, 'fixed-refresh');
  assert.equal(sent.length, 1);
});

test('并发请求中迟到的旧令牌 401 复用已刷新的令牌，只刷新一次', async t => {
  const { c } = fixture(t); let release, refreshes = 0;
  c.platform.token = async () => { refreshes++; return { access_token:'new', expires_in:900 }; };
  c.platform.api = async (token, path) => {
    if (token === 'access') {
      if (path.endsWith('/slow')) await new Promise(resolve => { release = resolve; });
      throw new Fault('invalid_token', 401);
    }
    assert.equal(token, 'new'); return { status:'running' };
  };
  const slow = c.api('/v1/agent/runs/slow');
  await c.api('/v1/agent/runs/fast'); release(); await slow;
  assert.equal(refreshes, 1); assert.equal(c.read().run.id, 'original-run');
});

test('提交响应丢失跨重启持续以原参数和幂等键确认，不产生第二个任务或费用', async t => {
  const bodies = [], created = new Map(); let lost = true;
  const f = fixture(t, async (url, init) => {
    assert.equal(new URL(url).pathname, '/v1/agent/threads/thread/messages');
    const body = JSON.parse(init.body); bodies.push(body);
    if (!created.has(body.idempotencyKey)) created.set(body.idempotencyKey, 'paid-run');
    if (lost) throw new Error('Network connection lost');
    return Response.json({ runId:created.get(body.idempotencyKey) });
  });
  let c = f.c; c.patch({ run:null, model:'selected', refs:[{ id:'reference', until:Date.now()+1000 }] });
  const msg = message('private prompt');
  for (let i = 0; i < 6; i++) {
    const outcome = await c.handleBatch([msg], c.read().epoch);
    assert.equal(outcome.complete, false); c = f.restart();
    c.patch({ refs:[], model:'changed' });
  }
  assert.equal(f.sent.length, 0); assert.equal(created.size, 1);
  assert.ok(!JSON.stringify(c.read()).includes('private prompt'));
  lost = false; assert.equal((await c.handleBatch([msg], c.read().epoch)).complete, true);
  assert.ok(bodies.every(body => JSON.stringify(body) === JSON.stringify(bodies[0])));
  assert.equal(c.read().run.id, 'paid-run'); assert.equal(c.read().submission, null);
  // 长任务超出去重记录期限后，活动 Run 仍保护触发它的那条消息。
  c.patch({ seen:[] }); await c.message(msg, c.read().epoch);
  assert.equal(bodies.length, 7); assert.equal(created.size, 1);
});

test('并发交付只查询与回复一次', async t => {
  const { c, sent } = fixture(t); let calls = 0, release;
  c.platform.api = async () => { calls++; await new Promise(resolve => { release = resolve; }); return { status:'completed', finalText:'最终答复' }; };
  const first = c.deliverSafely(c.read().epoch), second = c.deliverSafely(c.read().epoch);
  release(); await Promise.all([first,second]);
  assert.equal(calls, 1); assert.equal(sent.length, 1);
});

for (const failure of ['network', 'invalid-json']) test(`提交结果不确定后权限变更也不释放任务，新消息不会触发第二次生成：${failure}`, async t => {
  const bodies = [], created = new Map(); let phase = 'lost';
  const { c, sent } = fixture(t, async (_url, init) => {
    const body = JSON.parse(init.body); bodies.push(body);
    if (phase === 'denied') return Response.json({ code:'FORBIDDEN' }, { status:403 });
    if (!created.has(body.idempotencyKey)) created.set(body.idempotencyKey, 'accepted-run');
    if (phase === 'lost') {
      if (failure === 'invalid-json') return new Response('broken response', { status:202 });
      throw new Error('Network connection lost');
    }
    return Response.json({ runId:created.get(body.idempotencyKey) });
  });
  c.patch({ run:null }); const msg = message('生成一次');
  assert.equal((await c.handleBatch([msg], c.read().epoch)).complete, false);
  phase = 'denied'; assert.equal((await c.handleBatch([msg], c.read().epoch)).complete, false);
  assert.ok(c.read().submission.uncertain);
  await c.message(message('再次生成', '2'), c.read().epoch);
  assert.equal(bodies.length, 2); assert.match(sent.at(-1).item.text_item.text, /提交结果仍在确认/);
  phase = 'ok'; assert.equal((await c.handleBatch([msg], c.read().epoch)).complete, true);
  assert.equal(c.read().run.id, 'accepted-run'); assert.equal(created.size, 1);
  assert.ok(bodies.every(body => body.idempotencyKey === bodies[0].idempotencyKey));
});

test('首次提交明确拒绝时释放提交状态，不把权限拒绝当成已生成任务', async t => {
  let calls = 0;
  const { c, sent } = fixture(t, async () => { calls++; return Response.json({ code:'FORBIDDEN' }, { status:403 }); });
  c.patch({ run:null }); const msg = message('没有权限的请求');
  assert.equal((await c.handleBatch([msg], c.read().epoch)).complete, true);
  assert.equal(c.read().submission, null); assert.equal(c.read().run, null);
  await c.handleBatch([msg], c.read().epoch);
  assert.equal(calls, 1); assert.equal(sent.length, 1);
});

for (const fault of ['ack-lost', 'checkpoint-lost']) test(`发送回执或进度写入丢失后不重发已发送段落：${fault}`, async t => {
  const f = fixture(t); let c = f.c;
  const snapshot = { status:'completed', finalText:'第一段'.repeat(500)+'尾段', artifacts:[] };
  c.platform.api = async () => snapshot;
  let fail = true;
  const write = f.repo.write.bind(f.repo);
  if (fault === 'checkpoint-lost') f.repo.write = value => {
    if (fail && value.run?.sent === 1 && !value.run.sending) { fail = false; throw new Error('worker interrupted'); }
    write(value);
  };
  c.wx.send = async (_bot, _route, item, id) => {
    f.sent.push({ item,id });
    if (fault === 'ack-lost' && fail) { fail = false; throw new Fault('NETWORK_CONNECTION_LOST'); }
  };
  await c.deliverSafely(c.read().epoch);
  assert.ok(c.read().run.sending);
  c = f.restart(); c.platform.api = async () => snapshot; ready(c);
  await c.deliverSafely(c.read().epoch);
  assert.equal(new Set(f.sent.map(item => item.id)).size, f.sent.length);
  assert.equal(f.sent.filter(item => item.item.text_item.text.startsWith('第一段')).length, 1);
  assert.match(f.sent.at(-1).item.text_item.text, /未能确认送达/); assert.equal(c.read().run, null);
});

test('确认提示分段发送明确失败后从未发段落恢复，不重复已送达段落', async t => {
  const f = fixture(t); let c = f.c, sends = 0;
  const pending = { type:'confirmation', confirmations:Array.from({ length:30 }, (_, i) => ({ confirmationId:String(i), confirmationHash:'hash', request:{ prompt:'描述'.repeat(40) }, credit:{ estimatedCost:1 } })) };
  const snapshot = { status:'waiting_confirmation', pendingAction:pending };
  c.platform.api = async () => snapshot;
  c.wx.send = async (_bot, _route, item, id) => {
    if (++sends === 2) throw new Fault('WEIXIN_API_ERROR_-2');
    f.sent.push({ item,id });
  };
  await c.deliverSafely(c.read().epoch);
  assert.equal(c.read().run.noticeDelivery.sent, 1); assert.equal(c.read().run.noticeHash, null);
  c = f.restart(); c.platform.api = async () => snapshot; ready(c);
  await c.deliverSafely(c.read().epoch);
  assert.equal(c.read().run.noticeHash, c.hash(JSON.stringify(pending)));
  assert.equal(new Set(f.sent.map(item => item.id)).size, f.sent.length);
  const count = f.sent.length; await c.deliverSafely(c.read().epoch); assert.equal(f.sent.length, count);
});

test('未确认送达的报价不会重发或被文字确认执行', async t => {
  const { c, sent } = fixture(t); let confirms = 0, first = true;
  const pending = { type:'confirmation', confirmations:[{ confirmationId:'quote', confirmationHash:'hash', request:{ prompt:'猫' }, credit:{ estimatedCost:1 } }] };
  c.platform.api = async (_token, path) => { if (path.endsWith('/confirmation')) confirms++; return { status:'waiting_confirmation', pendingAction:pending }; };
  c.wx.send = async (_bot, _route, item, id) => { sent.push({ item,id }); if (first) { first = false; throw new Fault('NETWORK_TIMEOUT'); } };
  await c.deliverSafely(c.read().epoch); ready(c); await c.deliverSafely(c.read().epoch);
  assert.equal(c.read().run.noticeHash, null); assert.equal(c.read().run.noticeDelivery.uncertain, true);
  await c.message(message('确认'), c.read().epoch);
  assert.equal(confirms, 0); assert.equal(sent.filter(({ item }) => item.text_item.text.includes('请确认以下方案')).length, 1);
});

test('部分完成明确说明原因并交付已有图片，不重建任务', async t => {
  const { c, sent } = fixture(t); let uploads = 0;
  c.platform.api = async (_token, path, body) => {
    assert.equal(body, undefined);
    return path.includes('/resources/') ? new Uint8Array([1])
      : { status:'completed', partial:true, stopReason:'context_limit', finalText:'已完成第一章', artifacts:[{ resourceId:'image' }] };
  };
  c.wx.upload = async () => { uploads++; return { type:2, image_item:{ media:{} } }; };
  await c.deliverSafely(c.read().epoch); await c.deliverSafely(c.read().epoch);
  assert.match(sent[0].item.text_item.text, /任务部分完成/); assert.match(sent[0].item.text_item.text, /上下文窗口/);
  assert.match(sent[1].item.text_item.text, /第一章/); assert.equal(sent[2].item.type, 2); assert.equal(uploads, 1);
  c.patch({ run:{ id:'empty-partial', sent:0 } });
  c.platform.api = async () => ({ status:'completed', partial:true, stopReason:'tool_no_progress', finalText:'' });
  await c.deliverSafely(c.read().epoch);
  assert.match(sent.at(-1).item.text_item.text, /部分完成/); assert.doesNotMatch(sent.at(-1).item.text_item.text, /任务完成。/);
});

test('升级前已经发送正文的部分完成任务不改变旧分段序号', async t => {
  const { c, sent } = fixture(t); c.patch({ run:{ id:'original-run', sent:1 } });
  c.platform.api = async () => ({ status:'completed', partial:true, stopReason:'context_limit', finalText:'a'.repeat(1500)+'剩余正文' });
  await c.deliverSafely(c.read().epoch);
  assert.equal(sent.length, 2); assert.match(sent[0].item.text_item.text, /部分完成/);
  assert.equal(sent[1].item.text_item.text, '剩余正文'); assert.equal(c.read().run, null);
});

test('授权真正撤销会清空连接，旧交付不能恢复 runId 或发送结果', async t => {
  const { c, sent } = fixture(t);
  c.platform.api = async () => { throw new Fault('invalid_token',401); };
  c.platform.token = async () => { throw new Fault('invalid_grant',400); };
  await assert.rejects(c.deliverSafely(c.read().epoch), { code:'CONNECTION_CHANGED' });
  assert.equal(c.read().run, undefined); assert.equal(c.read().oauth, undefined); assert.equal(sent.length, 0);
});
