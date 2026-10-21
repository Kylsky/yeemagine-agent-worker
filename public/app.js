const $ = id => document.getElementById(id);
let csrf = '', generation = 0, qrUrl;
const errors = { LOGIN_REQUIRED:'登录已过期，请重新授权。', OAUTH_DISABLED:'平台暂时关闭 OAuth，连接信息已保留。', invalid_client:'客户端凭证无效，请检查 Cloudflare 中的 Client Secret。', AUTHORIZATION_EXPIRED:'平台授权已失效，请重新授权。', WEIXIN_COOLDOWN:'微信会话暂时不可用，将在一小时后重试。', OPERATION_IN_PROGRESS:'上一项操作尚未结束，请稍后重试。', QR_EXPIRED:'二维码已过期，请重新生成。', IDENTITY_MISMATCH:'登录账户与配置的应用所有者不一致。', BODY_TOO_LARGE:'图片超过 8 MB 限制。' };
function showError(e) { $('message').textContent = errors[e.message] || `操作未完成（${e.message}），请稍后重试或查看配置。`; }
async function api(path, body) {
  const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin', cache: 'no-store',
    headers: body === undefined ? {} : { 'Content-Type':'application/json', 'X-CSRF-Token':csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'NETWORK_ERROR');
  return data;
}
function clearQr() { generation++; $('qr-area').hidden = true; $('verify').hidden = true; $('code').value = ''; $('qr').removeAttribute('src'); if (qrUrl) URL.revokeObjectURL(qrUrl); qrUrl = null; }
async function refresh() {
  const state = await api('/api/status');
  $('setup').hidden = state.configured;
  $('address').hidden = !state.workerUrl;
  $('address').textContent = state.workerUrl ? `应用地址：${state.workerUrl}（可直接登记到平台，无需自定义域名）` : '';
  $('login').hidden = !state.configured || state.loggedIn;
  $('controls').hidden = !state.loggedIn;
  $('diagnostics').hidden = !state.loggedIn;
  const d = state.diagnostics || {};
  const time = value => value ? new Date(value).toLocaleTimeString() : '尚无';
  $('diagnostics').textContent = `接收诊断：轮询启动 ${time(d.alarmAt)}；最近返回 ${time(d.pollAt)}（${d.batchSize ?? 0} 条）；下次 ${time(state.nextPollAt)}；最近消息 ${time(d.inboundAt)} / ${d.result || '尚无'}（类型 ${d.messageType ?? '未提供'}，状态 ${d.messageState ?? '未提供'}）。`;

  if (!state.configured) {
    $('message').textContent = '部署已完成，等待填写平台配置。';
    $('missing').replaceChildren(...state.missing.map(name => { const li = document.createElement('li'); li.textContent = name; return li; })); return;
  }
  csrf = state.csrf || '';
  $('message').textContent = !state.loggedIn ? '第一步：授权你的平台账户。' : state.error ? errors[state.error] || `后台状态：${state.error}` : state.connected ? '连接已就绪，可以在微信中发送消息。' : '第二步：扫描二维码连接微信。';
  $('wx-status').textContent = state.connected ? '② 微信已连接' : '② 微信待连接';
  $('disconnect').hidden = !state.connected;
  $('qr-button').hidden = state.connected;
  if (state.connected) clearQr();
}
async function scan(myGeneration, code) {
  try {
    const data = await api('/api/scan', code ? { code } : {});
    if (myGeneration !== generation) return;
    const names = { wait:'等待扫码…', scaned:'已扫码，请在微信确认。', confirmed:'连接成功。', expired:'二维码已过期，请重新生成。', need_verifycode:'请填写微信显示的验证码。', verify_code_blocked:'验证码已被限制，请稍后重新扫码。', binded_redirect:'该二维码未返回新凭证，请重新生成二维码。', scaned_but_redirect:'正在完成微信连接…' };
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
  try { const data = await api('/api/qr', {}); qrUrl = URL.createObjectURL(new Blob([data.svg], { type:'image/svg+xml' })); $('qr').src = qrUrl; $('qr-area').hidden = false; scan(generation); }
  catch (e) { showError(e); } finally { $('qr-button').disabled = false; }
};
$('verify').onsubmit = event => { event.preventDefault(); const code = $('code').value; $('code').value = ''; $('verify').hidden = true; scan(generation, code); };
$('disconnect').onclick = async () => {
  if (!confirm('断开微信会清除本地会话和回复进度。平台上的任务可能仍在运行，断开前可先在微信发送 /cancel。')) return;
  clearQr(); try { await api('/api/disconnect', {}); await refresh(); } catch (e) { showError(e); }
};
$('revoke').onclick = async () => {
  if (!confirm('撤销平台授权并清除 Worker 内保存的凭证与连接数据？平台已有聊天记录不受影响。')) return;
  clearQr(); try { await api('/api/revoke', {}); await refresh(); } catch (e) { showError(e); }
};
refresh().catch(showError);
