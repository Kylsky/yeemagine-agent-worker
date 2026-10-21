const $ = id => document.getElementById(id);
let csrf = '', generation = 0, qrUrl;
const errors = {
  LOGIN_REQUIRED:'登录已过期，请重新授权。', SESSION_EXPIRED:'登录已过期，请重新授权（微信连接会保留）。',
  OAUTH_DISABLED:'平台暂停了授权，恢复后自动继续。', invalid_client:'Client Secret 不正确，请检查 OAUTH_CLIENT_SECRET。',
  AUTHORIZATION_EXPIRED:'授权已失效，请重新授权并扫码。', AUTHORIZATION_DENIED:'已取消授权。',
  INVALID_OAUTH_STATE:'授权链接已过期，请重新授权。', IDENTITY_MISMATCH:'账户与部署配置不一致，请换个账户授权。',
  RATE_LIMITED:'操作太快，请稍后再试。', WEIXIN_COOLDOWN:'微信暂时限制了连接，一小时后自动重试。',
  OPERATION_IN_PROGRESS:'上一个操作还没结束，请稍后再试。', QR_EXPIRED:'二维码已过期，请重新生成。', BODY_TOO_LARGE:'图片超过 8 MB。'
};
const describe = code => errors[code] || (/^PLATFORM_\w*NETWORK/.test(code) ? `连不上平台（${code}），请检查 PLATFORM_BASE_URL。` : '');
// 步骤条已经说明当前该做什么，状态行只在有额外信息时出现。
function say(text, tone = '') { $('message').textContent = text; $('message').className = 'status' + (tone ? ' ' + tone : ''); $('message').hidden = !text; }
function showError(e) { say(describe(e.message) || `操作未完成（${e.message}），请稍后重试。`, 'error'); }
// 授权回调失败会带着 ?error= 回到本页；读出后从地址栏去掉，刷新时不再重复提示。
const returned = /[?&]error=([A-Za-z0-9_-]{1,80})/.exec(String(window.location?.search || ''))?.[1];
if (returned) window.history?.replaceState?.(null, '', '/');
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'NETWORK_ERROR');
  return data;
}
function steps(current) {
  ['step-auth', 'step-wx', 'step-chat'].forEach((id, i) => { $(id).className = 'step' + (i < current ? ' done' : i === current ? ' current' : ''); });
}
function clearQr() { generation++; $('qr-area').hidden = true; $('verify').hidden = true; $('code').value = ''; $('qr').removeAttribute('src'); if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = null; }
async function refresh() {
  const state = await api('/api/status');
  $('setup').hidden = state.configured;
  $('address').hidden = !state.workerUrl;
  $('address').textContent = state.workerUrl || '';
  $('login').hidden = !state.configured || state.loggedIn;
  $('controls').hidden = !state.loggedIn;
  $('diagnostics-box').hidden = !state.loggedIn;
  const d = state.diagnostics || {};
  const time = value => value ? new Date(value).toLocaleTimeString() : '尚无';
  $('diagnostics').textContent = [`轮询启动：${time(d.alarmAt)}`, `最近返回：${time(d.pollAt)}（${d.batchSize ?? 0} 条）`, `下次轮询：${time(state.nextPollAt)}`,
    `最近消息：${time(d.inboundAt)} · ${d.result || '尚无'}（类型 ${d.messageType ?? '—'}，状态 ${d.messageState ?? '—'}）`,
    `最近结果发送失败：${d.deliveryError ? `${time(d.deliveryErrorAt)} · ${d.deliveryError}` : '无'}`,
    `最近回复失败：${d.sendError ? `${time(d.sendErrorAt)} · ${d.sendError}` : '无'}`].join('\n');

  if (!state.configured) {
    steps(-1); say('还差几项配置。', 'warn');
    $('missing').replaceChildren(...state.missing.map(name => { const li = document.createElement('li'); li.textContent = name; return li; })); return;
  }
  csrf = state.csrf || '';
  if (!state.loggedIn) {
    steps(0);
    return say(state.notice ? describe(state.notice) || '请重新授权。' : '', 'warn');
  }
  steps(state.connected ? 2 : 1);
  $('disconnect').hidden = !state.connected;
  $('qr-button').hidden = state.connected;
  if (state.connected) clearQr();
  if (state.cooldownUntil > Date.now()) say(`微信暂时限制了连接，${new Date(state.cooldownUntil).toLocaleTimeString()} 后自动重试。`, 'warn');
  else if (state.error) say(describe(state.error) || `后台出错（${state.error}），会自动重试。`, 'warn');
  else say(state.connected ? (state.running ? '已连接，正在处理任务。' : '已连接，可以在微信里对话了。') : '', 'ok');
}
async function scan(myGeneration, code) {
  try {
    const data = await api('/api/scan', code ? { code } : {});
    if (myGeneration !== generation) return;
    const names = { wait:'等待扫码…', scaned:'已扫码，请在手机上确认。', confirmed:'连接成功。', expired:'二维码已过期，请重新生成。', need_verifycode:'请输入微信上显示的验证码。', verify_code_blocked:'验证码尝试次数过多，请稍后重新扫码。', binded_redirect:'这个二维码没有拿到新的连接，请重新生成。', scaned_but_redirect:'正在完成连接…' };
    $('scan-status').textContent = names[data.status] || '等待微信响应…';
    if (data.status === 'confirmed') { clearQr(); await refresh(); return; }
    if (['expired','verify_code_blocked','binded_redirect'].includes(data.status)) { generation++; return; }
    if (data.status === 'need_verifycode') { $('verify').hidden = false; return; }
    setTimeout(() => { if (myGeneration === generation) scan(myGeneration); }, 1000);
  } catch (e) {
    if (myGeneration !== generation) return;
    if (scanStops.has(e.message)) return showError(e);
    // 网络抖动或上一个查询还没结束时不中断扫码，稍后带着同样的验证码继续查询。
    $('scan-status').textContent = '网络不稳定，正在重试…';
    setTimeout(() => { if (myGeneration === generation) scan(myGeneration, code); }, 2000);
  }
}
const scanStops = new Set(['QR_EXPIRED', 'LOGIN_REQUIRED', 'INVALID_VERIFY_CODE', 'DISCONNECT_FIRST', 'INVALID_WEIXIN_LOGIN']);
// 原生表单在 no-referrer 下会提交 Origin: null；fetch 保留同源 Origin。
$('login').onsubmit = async event => {
  event.preventDefault();
  const button = $('login').querySelector('button');
  if (button.disabled) return;
  button.disabled = true;
  try {
    const data = await api('/auth/login', {});
    window.location.assign(data.authorizationUrl);
  } catch (e) { showError(e); button.disabled = false; }
};
$('qr-button').onclick = async () => {
  $('qr-button').disabled = true; clearQr();
  try { const data = await api('/api/qr', {}); qrUrl = URL.createObjectURL(new Blob([data.svg], { type:'image/svg+xml' })); $('qr').src = qrUrl; $('scan-status').textContent = '请用微信扫一扫'; $('qr-area').hidden = false; scan(generation); }
  catch (e) { showError(e); } finally { $('qr-button').disabled = false; }
};
// 提交验证码时让旧的查询循环失效，只保留带验证码的这一条，避免两条循环同时查询。
$('verify').onsubmit = event => { event.preventDefault(); const code = $('code').value; $('code').value = ''; $('verify').hidden = true; scan(++generation, code); };
$('disconnect').onclick = async () => {
  if (!confirm('断开后需要重新扫码才能使用，确定断开吗？')) return;
  clearQr(); try { await api('/api/disconnect', {}); await refresh(); } catch (e) { showError(e); }
};
$('revoke').onclick = async () => {
  if (!confirm('撤销授权并清除 Worker 里的凭证和微信连接？')) return;
  clearQr();
  try {
    const data = await api('/api/revoke', {}); await refresh();
    if (data.platformRevoked === false) say('本地数据已清除。平台暂时连不上，请到平台「授权应用」里再撤销一次。', 'warn');
  } catch (e) { showError(e); }
};
refresh().then(() => { if (returned) showError(new Error(returned)); }).catch(showError);
