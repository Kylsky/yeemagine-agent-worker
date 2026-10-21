export const HELP = [
  '可以直接发文字聊天，也可以用这些命令：',
  '/new　开始新对话\n/image 描述　生成图片\n/models　查看模型\n/model 序号　切换模型\n/balance　查看积分\n/status　查看状态\n/cancel　取消当前任务',
  '中文也可以：/新对话 /生图 /模型 /余额 /状态 /取消',
  '先发图片再发要求，图片会作为参考（30 分钟内有效）。生图前会先发报价，回复「确认」才会执行。'
].join('\n\n');
const aliases = { 帮助:'help', 新对话:'new', 模型:'model', 余额:'balance', 状态:'status', 取消:'cancel', 生图:'image', models:'models', help:'help', new:'new', model:'model', balance:'balance', status:'status', cancel:'cancel', image:'image' };
export function parse(text) {
  text = String(text || '').trim();
  if (text.startsWith('//')) return { command: null, text: text.slice(1) };
  if (!text.startsWith('/')) return { command: null, text };
  const [word, ...rest] = text.slice(1).split(/\s+/);
  return { command: aliases[word.toLowerCase()] || 'unknown', text: rest.join(' ') };
}
export function chunks(text, length = 1500) {
  const chars = Array.from(String(text || ''));
  const result = [];
  for (let i = 0; i < chars.length; i += length) result.push(chars.slice(i, i + length).join(''));
  return result;
}
export const credit = value => {
  const n = Number(value);
  return Number.isFinite(n) ? String(Math.round(n * 100) / 100) : '—';
};
const clip = (text, max = 80) => {
  const chars = Array.from(String(text || '').trim());
  return chars.length > max ? chars.slice(0, max).join('') + '…' : chars.join('');
};
// 只展示用户看得懂的几个常见参数，其余技术参数留给平台页面。
const PARAMS = { size: '尺寸', aspect_ratio: '比例', aspectRatio: '比例', resolution: '分辨率', quality: '质量' };
function describe(c, index, total) {
  const r = c.request || {}, cost = c.credit || {};
  const count = Number(r.imageCount || cost.quantity) || 1;
  const lines = [`${total > 1 ? `${index + 1}. ` : ''}${r.mediaKind === 'video' ? '视频生成' : '图片生成'}${count > 1 ? ` × ${count} 张` : ''}`];
  if (r.modelKey) lines.push(`模型：${r.modelKey}`);
  const params = Object.entries(r.params || {}).filter(([k, v]) => PARAMS[k] && ['string', 'number'].includes(typeof v)).map(([k, v]) => `${PARAMS[k]} ${v}`);
  if (params.length) lines.push(`参数：${params.join('，')}`);
  if (r.sharedPrompt || r.prompt) lines.push(`描述：${clip(r.sharedPrompt || r.prompt)}`);
  lines.push(cost.variableCost
    ? `费用：按实际用量计费，预计约 ${credit(cost.estimatedCost)} 积分${cost.minBalance != null ? `（余额需不少于 ${credit(cost.minBalance)}）` : ''}`
    : `费用：${credit(cost.estimatedCost)} 积分`);
  return lines.join('\n');
}
export function confirmationText(pending, now = Date.now()) {
  const list = pending.confirmations || [];
  const total = list.reduce((sum, c) => sum + (Number(c.credit?.estimatedCost) || 0), 0);
  const expires = list.map(c => Date.parse(c.expiresAt)).filter(Number.isFinite);
  const minutes = expires.length ? Math.max(1, Math.round((Math.min(...expires) - now) / 60000)) : null;
  return ['请确认以下方案：', ...list.map((c, i) => describe(c, i, list.length)),
    ...(list.length > 1 ? [`合计约 ${credit(total)} 积分`] : []),
    `回复「确认」开始执行，回复「取消」放弃${minutes ? `（${minutes} 分钟内有效）` : ''}。`].join('\n\n');
}
const optionsOf = q => (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string');
export function inputText(pending) {
  const questions = pending.questions || [];
  const blocks = questions.map((q, i) => {
    const title = q.title || q.question || q.label || '请补充信息';
    const head = questions.length > 1 ? `${i + 1}. ${title}` : title;
    if (q.kind === 'resource') return `${head}\n（请发送一张图片）`;
    const options = optionsOf(q);
    return options.length ? `${head}\n${options.map((o, j) => `${j + 1}）${o}`).join('\n')}` : head;
  });
  const tip = questions.length > 1
    ? '请分行按「1=答案」回复；有选项的可以只回序号，图片问题可附图并写「2=图片1」。'
    : questions.some(q => optionsOf(q).length) ? '回复序号，或直接写你的想法。' : '直接回复即可。';
  return ['需要你补充一下：', ...blocks, tip].join('\n\n');
}
// 有选项的问题允许只回复序号，提交前换成对应选项的原文。
const pick = (q, value) => {
  const options = optionsOf(q), n = /^\d+$/.test(value.trim()) ? Number(value.trim()) : 0;
  return n >= 1 && n <= options.length ? options[n - 1] : value;
};
export function answersFor(questions, text) {
  if (questions.length === 1) return { [questions[0].id]: pick(questions[0], text) };
  const answers = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\s*=\s*(.+)$/);
    const q = m && questions[Number(m[1]) - 1];
    if (q) answers[q.id] = pick(q, m[2]);
  }
  return Object.keys(answers).length === questions.length ? answers : null;
}
export function balanceText(data) {
  const lines = [`当前积分：${credit(data.balance)}`];
  const e = data.expiring;
  if (e && Number(e.amount) > 0) lines.push(`其中 ${credit(e.amount)} 积分将在${e.daysUntil ? ` ${e.daysUntil} 天内` : '近期'}到期`);
  return lines.join('\n');
}
export const GAVE_UP = '平台暂时没有响应，这条消息没能处理，请稍后重发。';
export const UNDELIVERABLE = '这次的结果暂时发不出去，请到平台查看。';
export const IMAGE_TOO_LARGE = '有一张图片无法通过微信发送，请到平台查看。';
// 平台或微信拒绝某条消息时，回一句能照着做的话，而不是错误码。
const FAILURES = {
  AGENT_CREDIT_INSUFFICIENT: '积分不足，请到平台充值后再试。',
  OAUTH_DISABLED: '平台暂停了开放授权，请稍后再试。',
  BODY_TOO_LARGE: '图片太大了，请发送 8 MB 以内的图片。',
  UNSUPPORTED_IMAGE: '暂不支持这种图片格式，请发送 PNG、JPG、GIF 或 WebP 图片。',
  INVALID_MEDIA: '图片读取失败，请重新发送。',
  TOO_MANY_IMAGES: '一次最多使用 4 张参考图，请先发送 /new 清空。',
  REFERENCE_EXPIRED: '参考图已过期，请重新发送图片。',
  INVALID_MODEL: '当前模型不可用，请发送 /models 重新选择。',
  RESOURCE_NOT_FOUND: '这段对话在平台上已不存在，请发送 /new 开始新对话。',
  AGENT_THREAD_ARCHIVED: '这段对话已归档，请发送 /new 开始新对话。',
  Forbidden: '你的平台账户还没有开通 Agent 功能，请联系平台管理员。',
};
export const failureText = code => FAILURES[code] || `这条消息没能处理（${code}），请调整后重新发送。`;
