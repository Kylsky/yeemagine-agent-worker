// 微信 Bot 能显示代码块、行内代码、表格、分割线和加粗；规则参照腾讯官方插件的 markdown-filter：
// 图片语法整段删除，五六级标题和含中文的斜体去掉符号、保留文字，代码内容原样不动。
const CJK = /[⺀-鿿가-힯豈-﫿]/;
const FENCE = /^\s*```/;

function plain(part) {
  return part
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
    .replace(/^(\s*)#{5,6}\s+/, '$1')
    .replace(/(^|[^*\w])\*(?![\s*])([^*\n]+?)(?<![\s*])\*(?!\*)/g, (m, pre, inner) => CJK.test(inner) ? pre + inner : m)
    .replace(/(^|[^_\w])_(?![\s_])([^_\n]+?)(?<![\s_])_(?!_)/g, (m, pre, inner) => CJK.test(inner) ? pre + inner : m);
}

export function toWeixinMarkdown(text) {
  let fenced = false;
  return String(text || '').replace(/\r\n?/g, '\n').split('\n').map(line => {
    if (FENCE.test(line)) { fenced = !fenced; return line; }
    // 行内代码原样保留，只处理代码以外的文字。
    return fenced ? line : line.split(/(`[^`\n]*`)/).map((part, i) => i % 2 ? part : plain(part)).join('');
  }).join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

const size = text => Array.from(text).length;
function hardSplit(text, length) {
  const chars = Array.from(text), result = [];
  for (let i = 0; i < chars.length; i += length) result.push(chars.slice(i, i + length).join(''));
  return result;
}
// 按空行切成段落；代码块整体算一段，不在内部按空行切开。
function blocks(text) {
  const result = [];
  let current = [], fenced = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) fenced = !fenced;
    if (!fenced && !FENCE.test(line) && line.trim() === '') {
      if (current.length) result.push(current.join('\n'));
      current = [];
    } else current.push(line);
  }
  if (current.length) result.push(current.join('\n'));
  return result;
}
// 单段仍超长时按行打包；代码块拆开后每段各自补上开头和结尾的围栏，避免后半段失去代码格式。
function splitBlock(block, length) {
  const lines = block.split('\n');
  const fence = FENCE.test(lines[0]) ? lines[0] : null;
  const body = fence ? lines.slice(1, lines.at(-1)?.trim().startsWith('```') && lines.length > 1 ? -1 : undefined) : lines;
  const wrap = piece => fence ? `${fence}\n${piece}\n\`\`\`` : piece;
  const budget = fence ? Math.max(1, length - size(fence) - 5) : length;
  const result = [];
  let current = '';
  for (const line of body.flatMap(line => size(line) > budget ? hardSplit(line, budget) : [line])) {
    const joined = current ? `${current}\n${line}` : line;
    if (current && size(joined) > budget) { result.push(wrap(current)); current = line; }
    else current = joined;
  }
  if (current) result.push(wrap(current));
  return result;
}
export function chunks(text, length = 1500) {
  const result = [];
  let current = '';
  for (const block of blocks(String(text || ''))) {
    const joined = current ? `${current}\n\n${block}` : block;
    if (size(joined) <= length) { current = joined; continue; }
    if (current) result.push(current);
    current = '';
    if (size(block) <= length) current = block;
    else result.push(...splitBlock(block, length));
  }
  if (current) result.push(current);
  return result;
}
