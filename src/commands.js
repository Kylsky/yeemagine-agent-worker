export const HELP = '/help 帮助\n/new 新对话\n/models 模型列表\n/model 序号 切换模型\n/balance 积分余额\n/status 连接状态\n/cancel 取消任务\n/image 描述 生图\n报价后回复“确认”或“取消”。先发送图片可作为后续消息的参考图（30 分钟有效）。以 // 开头可发送普通斜杠文本。';
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
export function confirmationText(pending) {
  return '请核对以下方案及费用：\n' + pending.confirmations.map((c, i) => `${i + 1}. ${c.capability || ''} ${c.target || ''}\n${JSON.stringify(c.request)}\n积分：${JSON.stringify(c.credit)}\n有效期：${c.expiresAt || '以平台为准'}`).join('\n\n') + '\n\n回复“确认”执行以上方案，或“取消”。';
}
export function inputText(pending) {
  return '请补充：\n' + pending.questions.map((q, i) => `${i + 1}. ${q.question || q.label || q.title || q.id}${q.options ? '\n' + JSON.stringify(q.options) : ''}`).join('\n') + '\n单个问题直接回复；多个问题按“1=答案”分行回复；图片问题可附图并写“1=图片1”（数字为本条图片序号）。';
}
export function answersFor(questions, text) {
  if (questions.length === 1) return { [questions[0].id]: text };
  const answers = {};
  for (const line of text.split('\n')) {
    const m = line.match(/^(\d+)\s*=\s*(.+)$/);
    if (m && questions[Number(m[1]) - 1]) answers[questions[Number(m[1]) - 1].id] = m[2];
  }
  return Object.keys(answers).length === questions.length ? answers : null;
}
