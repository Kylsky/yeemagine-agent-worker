import test from 'node:test';
import assert from 'node:assert/strict';
import { Fault } from '../src/http.js';
import { confirmationText, inputText, answersFor, balanceText, failureText } from '../src/commands.js';
import { Connection } from '../src/connection.js';

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
  const c = new Connection(new Memory(), env); c.initialize();
  c.patch({ oauth:c.box({ access_token:'access', refresh_token:'refresh', expiresAt:Date.now()+900000 }, 'oauth'),
    bot:c.box({ bot_token:'bot-secret', baseurl:'https://ilinkai.weixin.qq.com' }, 'bot'), ownerHash:c.hash('owner'),
    route:c.box({ toUserId:'owner', contextToken:'context-secret' }, 'route'), thread:'thread', identityAt:Date.now() });
  const sent = []; c.wx.send = async (_bot, _route, item) => { sent.push(item); return {}; };
  return { c, sent };
}
const message = (text, id = '1') => ({ message_id:id, from_user_id:'owner', context_token:'context-secret', message_type:1, message_state:2, item_list:[{ type:1, text_item:{ text } }] });
async function authorize(c) {
  const login = await c.login();
  const state = new URL((await login.json()).authorizationUrl).searchParams.get('state');
  return { cookie: login.headers.get('set-cookie').split(';')[0], state };
}

test('re-authorizing the same account keeps the WeChat connection and invalidates in-flight work', async () => {
  const {c} = fixture(); c.patch({ cursor:'cursor', model:'model-a' });
  const {cookie, state} = await authorize(c);
  const url = new URL(env.PUBLIC_BASE_URL + '/auth/callback?code=code&state=' + state);
  c.platform.token = async () => ({ access_token:'access-2', refresh_token:'refresh-2', expires_in:900 });
  c.platform.api = async () => ({ userId:'123', clientId:'client' });
  const epoch = c.read().epoch;
  await c.callback(new Request(url, { headers:{ Cookie:cookie } }), url);
  const s = c.read();
  assert.ok(s.bot); assert.equal(s.cursor, 'cursor'); assert.equal(s.model, 'model-a'); assert.equal(s.thread, 'thread');
  assert.equal(s.epoch, epoch + 1); assert.equal(s.transaction, null);
  assert.equal(c.open(s.oauth, 'oauth').refresh_token, 'refresh-2');
});
test('failed or denied authorization returns to the page with a readable error code', async () => {
  const {c} = fixture();
  const stale = await c.handle(new Request(env.PUBLIC_BASE_URL + '/auth/callback?state=x&code=y'));
  assert.equal(stale.status, 303); assert.equal(stale.headers.get('location'), '/?error=INVALID_OAUTH_STATE');
  const {cookie, state} = await authorize(c);
  const denied = await c.handle(new Request(env.PUBLIC_BASE_URL + '/auth/callback?error=access_denied&state=' + state, { headers:{ Cookie:cookie } }));
  assert.equal(denied.headers.get('location'), '/?error=AUTHORIZATION_DENIED');
  assert.match(denied.headers.get('set-cookie'), /__Host-transaction=;/);
});
test('signed-out status explains why only to browsers that had a session', async () => {
  const {c} = fixture(); c.reset('AUTHORIZATION_EXPIRED');
  const returning = await (await c.handle(new Request(env.PUBLIC_BASE_URL + '/api/status', { headers:{ Cookie:'__Host-session=old' } }))).json();
  assert.equal(returning.loggedIn, false); assert.equal(returning.notice, 'AUTHORIZATION_EXPIRED');
  const stranger = await (await c.handle(new Request(env.PUBLIC_BASE_URL + '/api/status'))).json();
  assert.equal(stranger.notice, undefined);
});
test('a finished task is delivered while the WeChat long poll is still waiting', async () => {
  const {c, sent} = fixture(); c.patch({ run:{ id:'run', sent:0 } });
  let resolvePoll; c.wx.updates = () => new Promise(resolve => { resolvePoll = resolve; });
  c.platform.api = async () => ({ status:'completed', finalText:'画好了', artifacts:[] });
  const pending = c.receive(c.open(c.read().bot, 'bot'), '', c.read().epoch);
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(sent[0]?.text_item.text, '画好了'); assert.equal(c.read().run, null);
  resolvePoll({ msgs:[], get_updates_buf:'' });
  assert.deepEqual(await pending, { msgs:[], get_updates_buf:'' });
});
test('insufficient credit is answered in WeChat instead of retrying forever', async () => {
  const {c, sent} = fixture();
  c.wx.updates = async () => ({ msgs:[message('画一只猫')], get_updates_buf:'next' });
  c.platform.api = async (_token, path) => { if (path.endsWith('/messages')) throw new Fault('AGENT_CREDIT_INSUFFICIENT', 402); return {}; };
  await c.alarm();
  assert.equal(sent.at(-1).text_item.text, '积分不足，请到平台充值后再试。');
  assert.equal(c.read().cursor, 'next'); assert.equal(c.read().error, null);
});
test('quotes, questions and balance read as plain Chinese without raw JSON', () => {
  const quote = confirmationText({ confirmations:[{ request:{ mediaKind:'image', prompt:'一只猫', modelKey:'gpt-image', params:{ size:'1024x1024', seed:3 }, imageCount:2 },
    credit:{ estimatedCost:12.5, quantity:2 }, expiresAt:new Date(Date.now() + 10 * 60000).toISOString() }] });
  assert.match(quote, /^\*\*请确认以下方案\*\*/); assert.match(quote, /\*\*图片生成 × 2 张\*\*/); assert.match(quote, /- 模型：`gpt-image`/);
  assert.match(quote, /- 参数：尺寸 1024x1024/); assert.match(quote, /- 费用：\*\*12\.5 积分\*\*/); assert.match(quote, /10 分钟内有效/);
  assert.doesNotMatch(quote, /seed|[{}]/);
  const question = { id:'layout', title:'选择版式', kind:'select', options:['竖版', '横版'] };
  assert.match(inputText({ questions:[question] }), /\*\*选择版式\*\*\n1\. 竖版\n2\. 横版/);
  assert.match(inputText({ questions:[question, { id:'ref', title:'参考图', kind:'resource' }] }), /\*\*1\. 选择版式\*\*\n可选：`1` 竖版 · `2` 横版[\s\S]*\*\*2\. 参考图\*\*\n请发送一张图片/);
  assert.deepEqual(answersFor([question], '2'), { layout:'横版' });
  assert.deepEqual(answersFor([question], '做成方形'), { layout:'做成方形' });
  assert.equal(balanceText({ balance:12.5, expiring:{ amount:3, daysUntil:5 } }), '**当前积分：12.5**\n其中 3 积分将在 5 天内到期');
  assert.equal(balanceText({ balance:0, expiring:null }), '**当前积分：0**');
  assert.match(failureText('SOMETHING_NEW'), /SOMETHING_NEW/);
});
