const $ = id => document.getElementById(id);
let csrf = '', generation = 0, qrUrl;
const errors = {
  LOGIN_REQUIRED:'网页登录已过期，请重新授权。', SESSION_EXPIRED:'网页登录已过期，请重新授权，已连接的微信会保留。',
  OAUTH_DISABLED:'平台暂停了开放授权，连接信息已保留，恢复后会自动继续。', invalid_client:'Client Secret 不正确，请到 Cloudflare 检查 OAUTH_CLIENT_SECRET。',
  AUTHORIZATION_EXPIRED:'平台授权已失效或被撤销，Worker 已清除本地数据，请重新授权并扫码。', AUTHORIZATION_DENIED:'你在平台上拒绝了授权，需要时可以重新授权。',
  INVALID_OAUTH_STATE:'授权链接已过期或来自其他页面，请重新点击授权。', IDENTITY_MISMATCH:'授权的平台账户和部署配置的不一致，请换成正确的账户。',
  RATE_LIMITED:'点得太快了，请稍等几秒再试。', WEIXIN_COOLDOWN:'微信暂时限制了这个连接，一小时后会自动重试。',
  OPERATION_IN_PROGRESS:'上一个操作还没结束，请稍后再试。', QR_EXPIRED:'二维码已过期，请重新生成。', BODY_TOO_LARGE:'图片超过 8 MB 限制。'
};
const describe = code => errors[code]
  || (/^PLATFORM_\w*NETWORK/.test(code) ? `连不上平台（${code}），请确认 PLATFORM_BASE_URL 能从公网通过 HTTPS 访问。` : '');
function say(text, tone = '') { $('message').textContent = text; $('message').className = 'status' + (tone ? ' ' + tone : ''); }
function showError(e) { say(describe(e.message) || `操作未完成（${e.message}），请稍后重试或检查配置。`, 'error'); }
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
  $('address').textContent = state.workerUrl ? `本 Worker 地址：${state.workerUrl}` : '';
  $('login').hidden = !state.configured || state.loggedIn;
  $('controls').hidden = !state.loggedIn;
  $('diagnostics-box').hidden = !state.loggedIn;
  const d = state.diagnostics || {};
  const time = value => value ? new Date(value).toLocaleTimeString() : '尚无';
  $('diagnostics').textContent = [`轮询启动：${time(d.alarmAt)}`, `最近返回：${time(d.pollAt)}（${d.batchSize ?? 0} 条）`, `下次轮询：${time(state.nextPollAt)}`,
    `最近消息：${time(d.inboundAt)} · ${d.result || '尚无'}（类型 ${d.messageType ?? '—'}，状态 ${d.messageState ?? '—'}）`].join('\n');

  if (!state.configured) {
    steps(-1); say('部署完成，还差几项平台配置。', 'warn');
    $('missing').replaceChildren(...state.missing.map(name => { const li = document.createElement('li'); li.textContent = name; return li; })); return;
  }
  csrf = state.csrf || '';
  if (!state.loggedIn) {
    steps(0);
    return state.notice ? say(describe(state.notice) || '请重新授权你的平台账户。', 'warn') : say('第一步：授权你的平台账户。');
  }
  steps(state.connected ? 2 : 1);
  $('wx-status').textContent = state.connected ? '微信已连接' : '微信未连接';
  $('wx-status').className = 'badge' + (state.connected ? ' on' : '');
  $('disconnect').hidden = !state.connected;
  $('qr-button').hidden = state.connected;
  if (state.connected) clearQr();
  if (state.cooldownUntil > Date.now()) say(`微信暂时限制了这个连接，${new Date(state.cooldownUntil).toLocaleTimeString()} 后会自动重试。`, 'warn');
  else if (state.error) say(describe(state.error) || `后台遇到问题（${state.error}），会自动重试。`, 'warn');
  else if (state.connected) say(state.running ? '已连接，正在处理一个任务。' : '已连接。在微信里给 Bot 发条消息试试，发送 /help 查看命令。', 'ok');
  else say('第二步：生成二维码，用微信扫一扫。');
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
    setTimeout(() => { if (myGeneration === generation) scan(myGeneration); }, 1500);
  } catch (e) { if (myGeneration === generation) showError(e); }
}
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
$('verify').onsubmit = event => { event.preventDefault(); const code = $('code').value; $('code').value = ''; $('verify').hidden = true; scan(generation, code); };
$('disconnect').onclick = async () => {
  if (!confirm('断开后微信将收不到回复，需要重新扫码才能使用。如果有任务正在进行，可以先在微信发送 /cancel。确定断开吗？')) return;
  clearQr(); try { await api('/api/disconnect', {}); await refresh(); } catch (e) { showError(e); }
};
$('revoke').onclick = async () => {
  if (!confirm('撤销平台授权，并清除 Worker 里保存的凭证和微信连接？平台上的聊天记录不受影响。')) return;
  clearQr(); try { await api('/api/revoke', {}); await refresh(); } catch (e) { showError(e); }
};
refresh().then(() => { if (returned) showError(new Error(returned)); }).catch(showError);
