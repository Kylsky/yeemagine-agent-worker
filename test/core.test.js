import test from 'node:test';
import assert from 'node:assert/strict';
import { seal, unseal, sha256, digest } from '../src/crypto.js';
import { config, origin, bytes, imageMime, Fault } from '../src/http.js';
import { parse, chunks, answersFor } from '../src/commands.js';
import { aesKey, encryptMedia, decryptMedia, weixinUrl, Weixin } from '../src/weixin.js';
import { Connection } from '../src/connection.js';

const env = { PLATFORM_BASE_URL:'https://platform.example', PUBLIC_BASE_URL:'https://worker.example', OAUTH_CLIENT_ID:'client', PLATFORM_USER_ID:'123', OAUTH_CLIENT_SECRET:'test-secret', CREDENTIAL_ENCRYPTION_KEY:'1'.repeat(64) };
class Memory {
  constructor() { this.value = { epoch:0, seen:[], refs:[] }; }
  read() { return structuredClone(this.value); }
  write(v) { this.value = structuredClone(v); }
  async alarm(at) { this.at = at; }
  async getAlarm() { return this.at; }
}
function fixture() {
  const repo = new Memory(), c = new Connection(repo, env); c.initialize();
  c.patch({ oauth:c.box({ access_token:'access', refresh_token:'refresh', expiresAt:Date.now()+900000 }, 'oauth'),
    bot:c.box({ bot_token:'bot-secret', baseurl:'https://ilinkai.weixin.qq.com' }, 'bot'), ownerHash:c.hash('owner'),
    route:c.box({ toUserId:'owner', contextToken:'context-secret' }, 'route'), thread:'thread', identityAt:Date.now() });
  const sent = []; c.wx.send = async (_bot, _route, item) => { sent.push(item); return {}; };
  return { c, repo, sent };
}
const message = (text, id = '1') => ({ message_id:id, from_user_id:'owner', context_token:'context-secret', message_type:1, message_state:2, item_list:[{ type:1, text_item:{ text } }] });

test('AES-GCM binds purpose and detects tampering; HMAC does not store identifiers', () => {
  const box = seal(env.CREDENTIAL_ENCRYPTION_KEY, { secret:'value' }, 'oauth');
  assert.deepEqual(unseal(env.CREDENTIAL_ENCRYPTION_KEY, box, 'oauth'), { secret:'value' });
  assert.throws(() => unseal(env.CREDENTIAL_ENCRYPTION_KEY, box, 'bot'));
  assert.throws(() => unseal('2'.repeat(64), box, 'oauth'));
  assert.notEqual(digest(env.CREDENTIAL_ENCRYPTION_KEY, 'owner'), 'owner');
  assert.equal(sha256('abc'), 'ungWv48Bz-pBQUDeXa4iI7ADYaOWF3qctBD_YfIAFa0');
});
test('configuration and URL checks reject origin confusion', () => {
  assert.deepEqual(config(env), []);
  for (const url of ['http://example.com', 'https://user@example.com', 'https://example.com/path', 'https://example.com?x=1']) assert.equal(origin(url), null);
  for (const url of ['https://weixin.qq.com.evil.example/a', 'http://weixin.qq.com', 'https://a@weixin.qq.com/a', 'https://weixin.qq.com:8443/a']) assert.throws(() => weixinUrl(url));
  assert.equal(weixinUrl('https://ilinkai.weixin.qq.com/a').hostname, 'ilinkai.weixin.qq.com');
});
test('commands, quoted slash escaping, Unicode chunking and structured answers', () => {
  assert.deepEqual(parse('/生图 一只猫'), { command:'image', text:'一只猫' });
  assert.deepEqual(parse('//help'), { command:null, text:'/help' });
  assert.equal(parse('/unknown').command, 'unknown');
  assert.deepEqual(chunks('😀😀😀', 2), ['😀😀','😀']);
  assert.deepEqual(answersFor([{id:'a'},{id:'b'}], '1=红色\n2=竖版'), {a:'红色',b:'竖版'});
  assert.equal(answersFor([{id:'a'},{id:'b'}], '1=红色'), null);
});
test('bounded streaming rejects payload without Content-Length', async () => {
  await assert.rejects(bytes(new Response(new Uint8Array(50)), 49), { code:'BODY_TOO_LARGE' });
  assert.equal((await bytes(new Response(new Uint8Array(49)), 49)).length, 49);
});
test('WeChat AES ECB accepts both key encodings and handles aligned padding', () => {
  const key = Buffer.alloc(16, 42), plain = Buffer.alloc(16, 7), encrypted = encryptMedia(plain, key);
  assert.equal(encrypted.length, 32);
  assert.deepEqual(decryptMedia(encrypted, key), plain);
  assert.deepEqual(aesKey(key.toString('base64')), key);
  assert.deepEqual(aesKey(Buffer.from(key.toString('hex')).toString('base64')), key);
  assert.throws(() => aesKey('abc'));
  assert.throws(() => imageMime(Buffer.from('not image')));
});
test('WeChat QR polling never sends bearer or UIN headers', async () => {
  let seen;
  const wx = new Weixin(async (url, init) => { seen = {url:String(url),init}; return Response.json({status:'wait'}); });
  await wx.scan({baseurl:'https://ilinkai.weixin.qq.com',qrcode:'private-qr'}, '123456');
  assert.equal(seen.init.headers.Authorization, undefined);
  assert.equal(seen.init.headers['X-WECHAT-UIN'], undefined);
  assert.equal(seen.init.redirect, 'error');
});
test('same-origin CSRF rejects cross-site mutation and missing session', async () => {
  const {c} = fixture();
  await assert.rejects(c.handle(new Request(env.PUBLIC_BASE_URL+'/api/disconnect', {method:'POST',headers:{Origin:'https://evil.example'}})), {code:'INVALID_ORIGIN'});
  await assert.rejects(c.handle(new Request(env.PUBLIC_BASE_URL+'/api/disconnect', {method:'POST',headers:{Origin:env.PUBLIC_BASE_URL}})), {code:'LOGIN_REQUIRED'});
});
test('OAuth transaction binds browser, consumes once, uses PKCE and validates owner', async () => {
  const {c} = fixture();
  const login = await c.login();
  const location = new URL(login.headers.get('location'));
  assert.equal(location.searchParams.get('code_challenge_method'), 'S256');
  const txCookie = login.headers.get('set-cookie').split(';')[0];
  const url = new URL(env.PUBLIC_BASE_URL+'/auth/callback');
  url.search = new URLSearchParams({code:'code',state:location.searchParams.get('state')});
  await assert.rejects(c.callback(new Request(url), url), {code:'INVALID_OAUTH_STATE'});
  let verifier;
  c.platform.token = async fields => { verifier = fields.code_verifier; return {access_token:'next',refresh_token:'next-refresh',expires_in:900}; };
  c.platform.api = async () => ({userId:'123',clientId:'client'});
  const response = await c.callback(new Request(url,{headers:{Cookie:txCookie}}), url);
  assert.equal(response.status,303);
  assert.equal(sha256(verifier),location.searchParams.get('code_challenge'));
  assert.ok(c.read().sessionHash);
  await assert.rejects(c.callback(new Request(url,{headers:{Cookie:txCookie}}), url), {code:'INVALID_OAUTH_STATE'});
  assert.throws(() => c.identity({userId:'other',clientId:'client'}), {code:'IDENTITY_MISMATCH'});
});
test('refresh retains fixed refresh token and single-flights parallel requests', async () => {
  const {c} = fixture(); let count = 0;
  c.platform.token = async () => { count++; await new Promise(resolve => setTimeout(resolve, 5)); return {access_token:'new',expires_in:900}; };
  await Promise.all([c.refresh(c.read().epoch),c.refresh(c.read().epoch)]);
  assert.equal(count,1);
  assert.equal(c.open(c.read().oauth,'oauth').refresh_token,'refresh');
});
test('platform disabled preserves credentials; invalid grant clears them', async () => {
  const {c} = fixture();
  c.platform.token = async () => { throw new Fault('OAUTH_DISABLED',503); };
  await assert.rejects(c.refresh(c.read().epoch), {code:'OAUTH_DISABLED'});
  assert.ok(c.read().oauth); assert.ok(c.read().bot);
  c.platform.token = async () => { throw new Fault('invalid_grant',400); };
  await assert.rejects(c.refresh(c.read().epoch), {code:'invalid_grant'});
  assert.equal(c.read().oauth,undefined); assert.equal(c.read().bot,undefined);
});
test('stale external responses cannot repopulate state after disconnect/reset', async () => {
  const {c} = fixture();
  let finish;
  c.platform.api = () => new Promise(resolve => { finish = resolve; });
  const result = c.api('/oauth/me'); c.reset(); finish({userId:'123',clientId:'client'});
  await assert.rejects(result, {code:'CONNECTION_CHANGED'});
  assert.equal(c.read().oauth,undefined);
});
test('duplicate messages submit once; foreign users, groups and unsafe IDs never submit', async () => {
  const {c,repo} = fixture(); let submits = 0;
  c.platform.api = async (_token,path) => { assert.ok(path.endsWith('/messages')); submits++; return {runId:'run'}; };
  await c.message(message('secret prompt'),c.read().epoch);
  await c.message(message('secret prompt'),c.read().epoch);
  await c.message({...message('bad','2'),from_user_id:'stranger'},c.read().epoch);
  await c.message({...message('bad','3'),group_id:'group'},c.read().epoch);
  await c.message({...message('bad','4'),message_id:9007199254740992},c.read().epoch);
  assert.equal(submits,1);
  const disk = JSON.stringify(repo.value);
  for (const secret of ['secret prompt','context-secret','bot-secret','access','refresh']) assert.ok(!disk.includes('"'+secret+'"'));
});
test('unknown and quoted commands never submit paid work', async () => {
  const {c,sent} = fixture(); c.platform.api = async () => { throw new Error('should not submit'); };
  await c.message(message('/unknown'),c.read().epoch);
  const quoted = message('/image cat','2'); quoted.item_list[0].ref_msg = {title:'quote'};
  await c.message(quoted,c.read().epoch);
  assert.equal(sent.length,2); assert.equal(c.read().run,undefined);
});
test('confirmation requires the exact quote already delivered to WeChat', async () => {
  const {c,sent} = fixture(); c.patch({run:{id:'run',sent:0,noticeHash:null}});
  let confirms = 0;
  const pending = {type:'confirmation',confirmations:[{confirmationId:'c',confirmationHash:'h',request:{prompt:'cat'},credit:5}]};
  c.platform.api = async (_token,path) => { if(path.endsWith('/confirmation')) {confirms++;return {};} return {status:'waiting_confirmation',pendingAction:pending}; };
  await c.message(message('确认'),c.read().epoch);
  assert.equal(confirms,0); assert.ok(sent.length >= 2);
  await c.message(message('确认','2'),c.read().epoch);
  assert.equal(confirms,1);
});
test('image references remain stable across uncertain message submission', async () => {
  const {c} = fixture(); let uploads = 0; const bodies = [];
  c.wx.download = async () => ({data:Buffer.from('image'),mime:'image/png'});
  c.platform.api = async (_token,path,body) => {
    if(path.endsWith('/images')) {uploads++; return {resourceId:'image-1'};}
    bodies.push(body); if(bodies.length === 1) throw new Fault('NETWORK_ERROR'); return {runId:'run'};
  };
  const msg = message('edit'); msg.item_list.push({type:2,image_item:{}});
  await assert.rejects(c.message(msg,c.read().epoch), {code:'NETWORK_ERROR'});
  await c.message(msg,c.read().epoch);
  assert.equal(uploads,1); assert.deepEqual(bodies[0],bodies[1]);
});
test('terminal delivery resumes at saved segment without regenerating', async () => {
  const {c,sent} = fixture(); c.patch({run:{id:'run',sent:1,noticeHash:null}});
  c.platform.api = async () => ({status:'completed',finalText:'a'.repeat(1500)+'last',artifacts:[]});
  await c.deliver(c.read().epoch);
  assert.equal(sent.length,1); assert.equal(sent[0].text_item.text,'last'); assert.equal(c.read().run,null);
});
test('cleanup expires sensitive transactions and references without keeping plaintext', () => {
  const {c} = fixture(), until = Date.now() - 1;
  c.patch({transaction:c.box({until,verifier:'secret'},'transaction'),scan:c.box({until,qrcode:'qr'},'scan'),inbound:{until,refs:[{id:'resource'}]},refs:[{id:'resource',until}],sessionUntil:until,sessionHash:'hash'});
  c.cleanup(c.read().epoch);
  assert.equal(c.read().transaction,null);assert.equal(c.read().scan,null);assert.equal(c.read().inbound,null);assert.deepEqual(c.read().refs,[]);assert.equal(c.read().sessionHash,null);
});
test('alarm preserves cursor when submission fails and replays the same idempotency key', async () => {
  const {c} = fixture(); const bodies=[]; let fail=true;
  c.patch({cursor:'old'});
  c.wx.updates = async () => ({msgs:[message('hello')],get_updates_buf:'new'});
  c.platform.api = async (_t,path,body) => {
    if (path.endsWith('/messages')) {bodies.push(body);if(fail)throw new Fault('NETWORK_ERROR'); return {runId:'run'};}
    return {status:'running'};
  };
  await c.alarm(); assert.equal(c.read().cursor,'old');
  fail=false; await c.alarm(); assert.equal(c.read().cursor,'new');assert.deepEqual(bodies[0],bodies[1]);
});
test('alarm handles WeChat cooldown without deleting connection', async () => {
  const {c}=fixture(); c.wx.updates=async()=>{throw new Fault('WEIXIN_COOLDOWN');};
  await c.alarm(); assert.ok(c.read().bot); assert.ok(c.read().cooldownUntil>Date.now()+59*60000);
});
test('mixed text and image question maps numbered image answer to platform resource', async () => {
  const {c}=fixture(); c.patch({run:{id:'run',sent:0}}); let submitted;
  c.wx.download=async()=>({data:Buffer.from('image'),mime:'image/png'});
  c.platform.api=async(_t,path,body)=>{
    if(path.endsWith('/images'))return {resourceId:'resource-1'};
    if(path.endsWith('/user-input')){submitted=body;return {};}
    return {status:'waiting_input',pendingAction:{type:'input',toolCallId:'tool',questions:[{id:'style',kind:'text'},{id:'ref',kind:'resource'}]}};
  };
  const msg=message('1=水彩\n2=图片1');msg.item_list.push({type:2,image_item:{}});
  await c.message(msg,c.read().epoch);assert.deepEqual(submitted.answers,{style:'水彩',ref:'resource-1'});
});
test('terminal sends at most four segments per pass and retains delivery progress', async () => {
  const {c,sent}=fixture();c.patch({run:{id:'run',sent:0}});
  c.platform.api=async()=>({status:'completed',finalText:'a'.repeat(7501),artifacts:[]});
  await c.deliver(c.read().epoch);assert.equal(sent.length,4);assert.equal(c.read().run.sent,4);
  await c.deliver(c.read().epoch);assert.equal(sent.length,6);assert.equal(c.read().run,null);
});
