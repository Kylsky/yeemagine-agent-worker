import QRCode from 'qrcode';
import { random, sha256, digest, equal, seal, unseal } from './crypto.js';
import { config, origin, json, jsonBody, Fault, safeCode } from './http.js';
import { Platform } from './platform.js';
import { Weixin, API, weixinUrl } from './weixin.js';
import { empty } from './state.js';
import { HELP, parse, chunks, confirmationText, inputText, answersFor } from './commands.js';

const minute = 60000;
const cookie = (name, value, maxAge) => `__Host-${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
const getCookie = (req, name) => (req.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(`__Host-${name}=`))?.split('=')[1];
const encId = encodeURIComponent;
const terminal = new Set(['completed', 'failed', 'cancelled']);

export class Connection {
  constructor(repo, env, fetcher = fetch) {
    this.repo = repo; this.env = env; this.platform = new Platform(env, fetcher); this.wx = new Weixin(fetcher);
    this.busy = false; this.controlBusy = false; this.refreshing = null;
  }
  read() { return this.repo.read(); }
  patch(values, epoch) {
    const state = this.read();
    if (epoch !== undefined && state.epoch !== epoch) throw new Fault('CONNECTION_CHANGED', 409);
    Object.assign(state, values); this.repo.write(state); return state;
  }
  guard(epoch) { if (this.read().epoch !== epoch) throw new Fault('CONNECTION_CHANGED', 409); }
  key() { return this.env.CREDENTIAL_ENCRYPTION_KEY || this.repo.encryptionKey(); }
  box(value, purpose) { return seal(this.key(), value, purpose); }
  open(value, purpose) { return unseal(this.key(), value, purpose); }
  hash(value) { return digest(this.key(), String(value)); }
  reset(error) { this.repo.write({ ...empty(this.read().epoch + 1), fingerprint: this.fingerprint(), error }); }
  fingerprint() { return sha256(JSON.stringify([this.env.PLATFORM_BASE_URL, this.env.PUBLIC_BASE_URL, this.env.OAUTH_CLIENT_ID, this.env.PLATFORM_USER_ID, this.key()])); }
  initialize() {
    const missing = config(this.env);
    if (missing.length) return missing;
    if (this.read().fingerprint !== this.fingerprint()) this.reset();
    return [];
  }
  session(req) {
    const s = this.read(), value = getCookie(req, 'session');
    return (!s.sessionOrigin || s.sessionOrigin === new URL(req.url).origin) && value && s.sessionUntil > Date.now() && equal(this.hash(value), s.sessionHash) ? value : null;
  }
  csrf(session) { return this.hash('csrf:' + session); }
  identity(me) {
    if (String(me.userId) !== this.env.PLATFORM_USER_ID || me.clientId !== this.env.OAUTH_CLIENT_ID) throw new Fault('IDENTITY_MISMATCH', 403);
  }
  async api(path, body, mode, epoch = this.read().epoch) {
    this.guard(epoch);
    let s = this.read();
    if (!s.oauth) throw new Fault('LOGIN_REQUIRED', 401);
    let auth = this.open(s.oauth, 'oauth');
    if (auth.expiresAt <= Date.now() + 30000) auth = await this.refresh(epoch);
    try {
      const result = await this.platform.api(auth.access_token, path, body, mode);
      this.guard(epoch); return result;
    } catch (e) {
      this.guard(epoch);
      if (e.status !== 401 || e.code === 'invalid_client') throw e;
      auth = await this.refresh(epoch);
      try { const result = await this.platform.api(auth.access_token, path, body, mode); this.guard(epoch); return result; }
      catch (retry) { this.guard(epoch); if (retry.status === 401 && retry.code !== 'invalid_client') this.reset('AUTHORIZATION_EXPIRED'); throw retry; }
    }
  }
  async refresh(epoch) {
    if (this.refreshing?.epoch === epoch) return this.refreshing.promise;
    const promise = (async () => {
      const previous = this.open(this.read().oauth, 'oauth');
      try {
        const data = await this.platform.token({ grant_type: 'refresh_token', refresh_token: previous.refresh_token });
        this.guard(epoch);
        if (!data.access_token || !data.expires_in) throw new Fault('INVALID_TOKEN_RESPONSE');
        const next = { ...previous, access_token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
        this.patch({ oauth: this.box(next, 'oauth') }, epoch); return next;
      } catch (e) { this.guard(epoch); if (e.code === 'invalid_grant') this.reset('AUTHORIZATION_EXPIRED'); throw e; }
    })();
    this.refreshing = { epoch, promise };
    try { return await promise; } finally { if (this.refreshing?.promise === promise) this.refreshing = null; }
  }
  async handle(req) {
    const url = new URL(req.url), path = url.pathname;
    const publicOrigin = origin(url.origin);
    if (!publicOrigin || (this.env.PUBLIC_BASE_URL && publicOrigin !== origin(this.env.PUBLIC_BASE_URL))) throw new Fault('WRONG_ORIGIN', 403);
    const missing = this.initialize();
    if (path === '/api/status' && missing.length) return json({ configured: false, missing, workerUrl: publicOrigin, callbackUrl: publicOrigin + '/auth/callback' });
    if (missing.length) throw new Fault('CONFIGURATION_REQUIRED', 503);
    const session = this.session(req);
    if (path === '/api/status' && req.method === 'GET') {
      const s = this.read();
      // 部署或运行中断后恢复丢失的轮询；正在执行的轮询自行安排下一次。
      if (session && s.oauth && s.bot && !this.busy) await this.wake();
      return json(session ? { configured: true, loggedIn: true, connected: !!s.bot, running: !!s.run, model: s.model || null,
        diagnostics: s.diagnostics || {}, nextPollAt: await this.repo.getAlarm(), error: s.error || null, cooldownUntil: s.cooldownUntil || null, csrf: this.csrf(session) } : { configured: true, loggedIn: false, workerUrl: publicOrigin, callbackUrl: publicOrigin + '/auth/callback' });
    }
    if (req.method === 'POST') {
      if (req.headers.get('Origin') !== publicOrigin) throw new Fault('INVALID_ORIGIN', 403);
      if (path !== '/auth/login' && (!session || !equal(req.headers.get('X-CSRF-Token'), this.csrf(session)))) throw new Fault('LOGIN_REQUIRED', 401);
    }
    if (path === '/auth/login' && req.method === 'POST') return this.login(publicOrigin);
    if (path === '/auth/callback' && req.method === 'GET') return this.callback(req, url);
    if (!session) throw new Fault('LOGIN_REQUIRED', 401);
    if (req.method !== 'POST') throw new Fault('NOT_FOUND', 404);
    // Disconnect remains available even while the platform is suspended or unavailable.
    if (path === '/api/disconnect') {
      const s = this.read();
      this.patch({ epoch: s.epoch + 1, bot: null, ownerHash: null, route: null, scan: null, cursor: '', seen: [], refs: [], inbound: null, run: null, thread: null, cooldownUntil: null });
      return json({ ok: true });
    }
    if (this.controlBusy) throw new Fault('OPERATION_IN_PROGRESS', 409);
    this.controlBusy = true;
    const epoch = this.read().epoch;
    try {
      this.identity(await this.api('/oauth/me', undefined, undefined, epoch));
      if (path === '/api/revoke') {
        const auth = this.open(this.read().oauth, 'oauth');
        await this.platform.token({ token: auth.refresh_token }, '/oauth/revoke');
        this.guard(epoch); this.reset();
        return json({ ok: true }, 200, { 'Set-Cookie': cookie('session', '', 0) });
      }
      if (path === '/api/qr') {
        if (this.read().bot) throw new Fault('DISCONNECT_FIRST', 409);
        const data = await this.wx.qr(); this.guard(epoch);
        const svg = await QRCode.toString(data.qrcode_img_content, { type: 'svg', errorCorrectionLevel: 'M', margin: 2 });
        this.guard(epoch);
        this.patch({ scan: this.box({ qrcode: data.qrcode, baseurl: API, until: Date.now() + 10 * minute }, 'scan') }, epoch);
        return json({ svg });
      }
      if (path === '/api/scan') {
        const body = await jsonBody(req, 1024);
        if (body.code && !/^\d{4,10}$/.test(body.code)) throw new Fault('INVALID_VERIFY_CODE', 400);
        const saved = this.read().scan;
        if (!saved) throw new Fault('QR_EXPIRED', 410);
        const scan = this.open(saved, 'scan');
        if (scan.until < Date.now()) { this.patch({ scan: null }, epoch); throw new Fault('QR_EXPIRED', 410); }
        const data = await this.wx.scan(scan, body.code); this.guard(epoch);
        if (data.status === 'scaned_but_redirect') {
          scan.baseurl = weixinUrl(`https://${data.redirect_host}`).origin;
          this.patch({ scan: this.box(scan, 'scan') }, epoch);
        } else if (data.status === 'confirmed') {
          if (!data.bot_token || !data.ilink_bot_id || !data.ilink_user_id || !data.baseurl) throw new Fault('INVALID_WEIXIN_LOGIN');
          const baseurl = weixinUrl(data.baseurl).origin;
          this.patch({ bot: this.box({ bot_token: data.bot_token, ilink_bot_id: data.ilink_bot_id, baseurl }, 'bot'),
            ownerHash: this.hash(data.ilink_user_id), scan: null, cursor: '', error: null, cooldownUntil: null }, epoch);
          await this.repo.alarm(Date.now() + 1000);
        } else if (data.status === 'expired' || data.status === 'binded_redirect') this.patch({ scan: null }, epoch);
        return json({ status: data.status });
      }
      throw new Fault('NOT_FOUND', 404);
    } catch (e) { if (e.code === 'IDENTITY_MISMATCH') this.reset(e.code); throw e; }
    finally { this.controlBusy = false; }
  }
  async login(publicOrigin = origin(this.env.PUBLIC_BASE_URL)) {
    if (!publicOrigin) throw new Fault('WRONG_ORIGIN', 403);
    const now = Date.now(), s = this.read();
    if (s.loginAt && now - s.loginAt < 10000) throw new Fault('RATE_LIMITED', 429);
    const state = random(), browser = random(), verifier = random();
    await this.repo.alarm(now + minute);
    this.patch({ loginAt: now, transaction: this.box({ publicOrigin, state, browserHash: this.hash(browser), verifier, until: now + 10 * minute }, 'transaction') });
    const url = new URL('/oauth/authorize', this.env.PLATFORM_BASE_URL);
    url.search = new URLSearchParams({ response_type: 'code', client_id: this.env.OAUTH_CLIENT_ID,
      redirect_uri: new URL('/auth/callback', publicOrigin).href, scope: 'agent', state,
      code_challenge: sha256(verifier), code_challenge_method: 'S256' });
    // 通过 JSON 返回授权地址，避免 fetch 跟随跨域重定向。
    return Response.json({ authorizationUrl: url.href }, { headers: { 'Set-Cookie': cookie('transaction', browser, 600) } });
  }
  async callback(req, url) {
    const s = this.read();
    if (!s.transaction) throw new Fault('INVALID_OAUTH_STATE', 400);
    const tx = this.open(s.transaction, 'transaction');
    if ((tx.publicOrigin || origin(this.env.PUBLIC_BASE_URL)) !== url.origin || tx.until < Date.now() || !equal(tx.state, url.searchParams.get('state')) || !equal(tx.browserHash, this.hash(getCookie(req, 'transaction') || ''))) throw new Fault('INVALID_OAUTH_STATE', 400);
    this.patch({ transaction: null }, s.epoch);
    if (url.searchParams.has('error')) throw new Fault('AUTHORIZATION_DENIED', 400);
    const code = url.searchParams.get('code');
    if (!code || code.length > 1024) throw new Fault('INVALID_CODE', 400);
    const token = await this.platform.token({ grant_type: 'authorization_code', code, code_verifier: tx.verifier,
      redirect_uri: new URL('/auth/callback', tx.publicOrigin || this.env.PUBLIC_BASE_URL).href });
    this.guard(s.epoch);
    if (!token.access_token || !token.refresh_token || !token.expires_in) throw new Fault('INVALID_TOKEN_RESPONSE');
    const me = await this.platform.api(token.access_token, '/oauth/me'); this.guard(s.epoch); this.identity(me);
    const session = random();
    this.reset();
    this.patch({ oauth: this.box({ access_token: token.access_token, refresh_token: token.refresh_token, expiresAt: Date.now() + token.expires_in * 1000 }, 'oauth'),
      sessionOrigin: url.origin, sessionHash: this.hash(session), sessionUntil: Date.now() + 7 * 86400000, identityAt: Date.now() });
    await this.repo.alarm(Date.now() + minute);
    const headers = new Headers({ Location: '/' });
    headers.append('Set-Cookie', cookie('session', session, 7 * 86400));
    headers.append('Set-Cookie', cookie('transaction', '', 0));
    return new Response(null, { status: 303, headers });
  }
  async wake() { if (!await this.repo.getAlarm()) await this.repo.alarm(Date.now() + 1000); }
  cleanup(epoch) {
    const s = this.read(), now = Date.now();
    this.patch({ seen: (s.seen || []).filter(x => now - x.at < 3 * 86400000).slice(-500), refs: (s.refs || []).filter(x => x.until > now),
      ...(s.sessionUntil < now ? { sessionHash: null, sessionUntil: null } : {}),
      ...(s.transaction && this.open(s.transaction, 'transaction').until < now ? { transaction: null } : {}),
      ...(s.scan && this.open(s.scan, 'scan').until < now ? { scan: null } : {}),
      ...(s.inbound?.until < now ? { inbound: null } : {}) }, epoch);
  }
  async alarm() {
    if (this.busy || this.initialize().length) return;
    this.busy = true;
    const epoch = this.read().epoch;
    let delay = 1000;
    // A backup survives eviction/failure; cron restores an absent alarm.
    try {
      await this.repo.alarm(Date.now() + 60000);
      this.patch({ diagnostics: { ...this.read().diagnostics, alarmAt: Date.now() } }, epoch);
      this.cleanup(epoch);
      let s = this.read();
      if (!s.oauth) { delay = s.transaction || s.scan ? minute : 0; return; }
      if (!s.identityAt || Date.now() - s.identityAt > minute) {
        this.identity(await this.api('/oauth/me', undefined, undefined, epoch));
        this.patch({ identityAt: Date.now() }, epoch);
      }
      s = this.read();
      if (!s.bot) { delay = minute; return; }
      if (s.cooldownUntil > Date.now()) { delay = Math.min(s.cooldownUntil - Date.now(), minute); return; }
      if (s.run && s.route) await this.deliver(epoch);
      s = this.read();
      const bot = this.open(s.bot, 'bot');
      const batch = await this.wx.updates(bot, s.cursor); this.guard(epoch);
      this.patch({ diagnostics: { ...this.read().diagnostics, pollAt: Date.now(), batchSize: (batch.msgs || []).length } }, epoch);
      const deadline = Date.now() + 20000;
      let complete = true;
      for (const msg of batch.msgs || []) {
        if (Date.now() > deadline) { complete = false; break; }
        try { await this.message(msg, epoch); }
        catch (e) {
          this.guard(epoch);
          if ([400, 403, 404, 413, 415].includes(e.status) && msg.from_user_id && equal(this.hash(msg.from_user_id), this.read().ownerHash) && msg.message_id) {
            const key = this.hash('message:' + msg.from_user_id + ':' + msg.message_id);
            await this.send(`这条消息无法处理（${safeCode(e)}），请调整后重新发送。`, epoch, key);
            this.mark(key, epoch, { inbound: null });
          } else throw e;
        }
      }
      if (complete && typeof batch.get_updates_buf === 'string' && batch.get_updates_buf) this.patch({ cursor: batch.get_updates_buf }, epoch);
      if (this.read().run && this.read().route) await this.deliver(epoch);
      this.patch({ error: null, failures: 0 }, epoch);
    } catch (e) {
      if (this.read().epoch === epoch) {
        if (e.code === 'IDENTITY_MISMATCH') this.reset(e.code);
        else {
          const failures = (this.read().failures || 0) + 1;
          delay = e.code === 'WEIXIN_COOLDOWN' ? minute : Math.min(10 * minute, 5000 * 2 ** Math.min(failures, 7));
          this.patch({ error: safeCode(e), failures, ...(e.code === 'WEIXIN_COOLDOWN' ? { cooldownUntil: Date.now() + 60 * minute } : {}) }, epoch);
        }
      }
    } finally {
      this.busy = false;
      if (delay) await this.repo.alarm(Date.now() + delay);
      else await this.repo.deleteAlarm();
    }
  }
  async send(text, epoch, id = random(12)) {
    const s = this.read(); this.guard(epoch);
    if (!s.bot || !s.route) throw new Fault('WEIXIN_REPLY_UNAVAILABLE');
    const bot = this.open(s.bot, 'bot'), route = this.open(s.route, 'route');
    let i = 0;
    for (const part of chunks(text)) {
      this.guard(epoch);
      await this.wx.send(bot, route, { type: 1, text_item: { text: part } }, `ym_${id}_${i++}`);
      this.guard(epoch);
    }
  }
  mark(key, epoch, extra = {}) {
    const s = this.read();
    this.patch({ ...extra, seen: [...s.seen.filter(x => x.key !== key), { key, at: Date.now() }].slice(-500) }, epoch);
  }
  async message(msg, epoch) {
    this.guard(epoch);
    const rejected = reason => this.patch({ diagnostics: { ...this.read().diagnostics, inboundAt: Date.now(), result: reason,
      messageType: typeof msg.message_type === 'number' ? msg.message_type : null,
      messageState: typeof msg.message_state === 'number' ? msg.message_state : null } }, epoch);
    if (msg.group_id) return rejected('GROUP');
    if (msg.message_type !== 1) return rejected('MESSAGE_TYPE');
    if (msg.message_state != null && ![0, 2].includes(msg.message_state)) return rejected('MESSAGE_STATE');
    if (!msg.from_user_id || !msg.context_token) return rejected('MISSING_SENDER_OR_CONTEXT');
    if (!equal(this.hash(msg.from_user_id), this.read().ownerHash)) return rejected('OWNER_MISMATCH');
    if (!msg.message_id || (typeof msg.message_id === 'number' && !Number.isSafeInteger(msg.message_id))) return rejected('INVALID_MESSAGE_ID');
    const key = this.hash('message:' + msg.from_user_id + ':' + msg.message_id);
    if (this.read().seen.some(x => x.key === key)) return rejected('DUPLICATE');
    rejected('ACCEPTED');
    this.patch({ route: this.box({ toUserId: msg.from_user_id, contextToken: msg.context_token }, 'route') }, epoch);
    const items = msg.item_list || [];
    const raw = items.filter(i => i.type === 1).map(i => i.text_item?.text || '').join('\n');
    const command = parse(raw);
    const reply = async text => { await this.send(text, epoch, key); this.mark(key, epoch); };
    if (items.some(i => ![1, 2].includes(i.type))) return reply('暂不支持语音、视频和文件，请发送文字或图片。');
    if (command.command && items.some(i => i.ref_msg)) return reply('引用消息中的命令不执行，请单独发送命令。');
    let s = this.read();
    if (command.command === 'help') return reply(HELP);
    if (command.command === 'unknown') return reply('未知命令。发送 /help 查看帮助；普通文本以 // 开头可保留斜杠。');
    if (command.command === 'status') return reply(`微信已连接；${s.run ? '任务进行中' : '空闲'}；模型：${s.model || '平台默认'}。`);
    if (command.command === 'balance') {
      const data = await this.api('/v1/account/balance', undefined, undefined, epoch);
      return reply(`积分余额：${JSON.stringify(data.balance)}\n即将过期：${JSON.stringify(data.expiring)}`);
    }
    if (command.command === 'models' || command.command === 'model') {
      const data = await this.api('/v1/agent/models', undefined, undefined, epoch);
      if (command.text && command.command === 'model') {
        if (s.run) return reply('请等待当前任务完成后切换模型。');
        if (!/^\d+$/.test(command.text) || !data.models[Number(command.text) - 1]) return reply('模型序号无效，请发送 /models 查看。');
        const model = data.models[Number(command.text) - 1];
        this.patch({ model: model.id }, epoch); return reply('已切换：' + model.label);
      }
      return reply(data.models.map((m, i) => `${i + 1}. ${m.label}${m.id === s.model ? '（当前）' : ''}`).join('\n') + '\n发送 /model 序号 切换。');
    }
    if (command.command === 'cancel' || (!command.command && command.text === '取消' && s.run)) {
      if (!s.run) return reply('当前没有任务。');
      await this.api(`/v1/agent/runs/${encId(s.run.id)}/cancel`, {}, undefined, epoch);
      return reply('已提交取消，正在等待任务结束。');
    }
    if (command.command === 'new') {
      if (s.run) return reply('请先等待任务结束或发送 /cancel。');
      this.patch({ thread: null, refs: [] }, epoch); return reply('已开始新对话。');
    }
    if (s.run) {
      const run = await this.api(`/v1/agent/runs/${encId(s.run.id)}`, undefined, undefined, epoch);
      if (run.pendingAction?.type === 'confirmation' && command.text === '确认' && !command.command) {
        const pending = run.pendingAction;
        if (this.hash(JSON.stringify(pending)) !== s.run.noticeHash) {
          await this.deliver(epoch); return reply('报价已更新或尚未完整送达，请核对最新报价后再次回复“确认”。');
        }
        try {
          await this.api(`/v1/agent/runs/${encId(s.run.id)}/confirmation`, { action: 'confirm', confirmations: pending.confirmations.map(c => ({ confirmationId: c.confirmationId, confirmationHash: c.confirmationHash })) }, undefined, epoch);
        } catch (e) { if (e.status === 409) { await this.deliver(epoch); return reply('报价状态已改变，请核对最新信息后重试。'); } throw e; }
        return reply('已确认，正在执行。');
      }
      if (run.pendingAction?.type === 'input' && !command.command) {
        const p = run.pendingAction;
        let answers;
        const inputImages = items.filter(i => i.type === 2);
        if (inputImages.length && p.questions.length === 1 && p.questions[0].kind === 'resource') {
          if (inputImages.length !== 1) return reply('请发送一张图片回答当前问题。');
          const refs = await this.references(inputImages, key, epoch, []);
          answers = { [p.questions[0].id]: refs[0].id };
        } else {
          if (!command.text) return reply(inputText(p));
          answers = answersFor(p.questions, command.text);
          if (answers && inputImages.length) {
            const refs = await this.references(inputImages, key, epoch, []);
            for (const q of p.questions.filter(q => q.kind === 'resource')) {
              const match = answers[q.id]?.match(/^图片(\d*)$/);
              if (match) {
                const index = match[1] ? Number(match[1]) - 1 : 0;
                if (!refs[index]) return reply('图片序号无效，请按问题编号回复，例如 1=图片1。');
                answers[q.id] = refs[index].id;
              }
            }
          }
        }
        if (!answers) return reply(inputText(p));
        await this.api(`/v1/agent/runs/${encId(s.run.id)}/user-input`, { toolCallId: p.toolCallId, answers }, undefined, epoch);
        this.patch({ inbound: null }, epoch); return reply('已收到补充信息。');
      }
      return reply('当前任务进行中，请等待完成或发送 /cancel；暂不排队处理新消息。');
    }
    const images = items.filter(i => i.type === 2);
    if (images.length > 4) return reply('一次最多发送 4 张参考图。');
    const refs = await this.references(images, key, epoch, s.refs.filter(r => r.until > Date.now()));
    if (refs.length > 4) return reply('最多保留 4 张参考图，请先发送 /new 清空。');
    if (!command.text) {
      if (images.length) { this.mark(key, epoch, { refs, inbound: null }); await this.send('参考图已收到，请在 30 分钟内发送要求。', epoch, key); return; }
      return reply(command.command === 'image' ? '用法：/image 图片描述' : '请发送文字或图片。');
    }
    if (command.text.length > 16000) return reply('消息过长，请缩短至 16000 字以内。');
    if (!s.thread) {
      const thread = await this.api('/v1/agent/threads', { title: '微信对话', ...(s.model ? { model: s.model } : {}) }, undefined, epoch);
      this.patch({ thread: thread.threadId }, epoch);
    }
    s = this.read();
    // Keep references for an uncertain submission; replay uses the same message HMAC.
    this.patch({ refs }, epoch);
    const run = await this.api(`/v1/agent/threads/${encId(s.thread)}/messages`, {
      text: command.text, mode: command.command === 'image' ? 'image' : 'agent', ...(s.model ? { model: s.model } : {}),
      refs: refs.map(r => ({ type: 'resource', id: r.id })), idempotencyKey: 'wx:' + key
    }, undefined, epoch);
    this.mark(key, epoch, { refs: [], inbound: null, run: { id: run.runId, sent: 0, noticeHash: null } });
    await this.send('已收到，正在处理。', epoch, key);
  }
  async references(images, key, epoch, existing) {
    let staged = this.read().inbound;
    if (!staged || staged.key !== key) staged = { key, refs: existing, uploaded: 0, until: Date.now() + 30 * minute };
    if (staged.until < Date.now()) throw new Fault('REFERENCE_EXPIRED', 400);
    if (staged.refs.length + images.length - staged.uploaded > 4) throw new Fault('TOO_MANY_IMAGES', 400);
    for (let i = staged.uploaded; i < images.length; i++) {
      const { data, mime } = await this.wx.download(images[i].image_item); this.guard(epoch);
      const form = new FormData(); form.set('file', new Blob([data], { type: mime }), 'reference.' + mime.split('/')[1]);
      const uploaded = await this.api('/v1/agent/images', form, undefined, epoch);
      staged = { ...staged, uploaded: i + 1, refs: [...staged.refs, { id: uploaded.resourceId, until: staged.until }] };
      this.patch({ inbound: staged }, epoch);
    }
    return staged.refs;
  }
  async deliver(epoch) {
    const s = this.read();
    if (!s.run) return;
    const run = await this.api(`/v1/agent/runs/${encId(s.run.id)}`, undefined, undefined, epoch);
    const pending = run.pendingAction;
    if (pending?.type === 'confirmation' || pending?.type === 'input') {
      const hash = this.hash(JSON.stringify(pending));
      if (s.run.noticeHash !== hash) {
        await this.send(pending.type === 'confirmation' ? confirmationText(pending) : inputText(pending), epoch, this.hash(s.run.id + hash));
        this.patch({ run: { ...s.run, noticeHash: hash } }, epoch);
      }
      return;
    }
    if (!terminal.has(run.status)) return;
    const parts = chunks(run.finalText || (run.status === 'cancelled' ? '任务已取消。' : run.status === 'failed' ? '任务失败，请在平台查看详情。' : '任务完成。'));
    const artifacts = run.artifacts || [];
    const bot = this.open(s.bot, 'bot'), route = this.open(s.route, 'route');
    for (let i = s.run.sent; i < Math.min(parts.length + artifacts.length, s.run.sent + 4); i++) {
      this.guard(epoch);
      let item;
      if (i < parts.length) item = { type: 1, text_item: { text: parts[i] } };
      else {
        const data = await this.api(`/v1/agent/resources/${encId(artifacts[i - parts.length].resourceId)}/content`, undefined, 'bytes', epoch);
        item = await this.wx.upload(bot, route, data); this.guard(epoch);
      }
      await this.wx.send(bot, route, item, 'ym_' + this.hash(s.run.id + ':' + i)); this.guard(epoch);
      this.patch({ run: { ...s.run, sent: i + 1 } }, epoch);
    }
    if (this.read().run.sent >= parts.length + artifacts.length) this.patch({ run: null }, epoch);
  }
}
