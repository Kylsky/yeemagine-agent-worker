import test from 'node:test';
import assert from 'node:assert/strict';
import { toWeixinMarkdown, chunks } from '../src/markdown.js';

test('answers keep the Markdown WeChat can show and drop what it cannot', () => {
  const answer = [
    '## 方案', '**加粗** 和 *中文斜体* 以及 *English italic*', '##### 小标题', '![示意图](https://platform.example/a.png)',
    '| 列 | 值 |', '| --- | --- |', '| a | 1 |', '---', '- 列表项 `*不动*`', '```js', 'const s = "*保留*"; // ![x](y)', '```'
  ].join('\n');
  assert.equal(toWeixinMarkdown(answer), [
    '## 方案', '**加粗** 和 中文斜体 以及 *English italic*', '小标题', '',
    '| 列 | 值 |', '| --- | --- |', '| a | 1 |', '---', '- 列表项 `*不动*`', '```js', 'const s = "*保留*"; // ![x](y)', '```'
  ].join('\n'));
  assert.equal(toWeixinMarkdown('第一段\r\n\r\n\r\n\r\n第二段'), '第一段\n\n第二段');
  assert.equal(toWeixinMarkdown(''), '');
});
test('long answers split between paragraphs instead of in the middle of a list', () => {
  const list = Array.from({ length: 5 }, (_, i) => `- 第 ${i + 1} 项`).join('\n');
  const parts = chunks(['开头一段话', list, '结尾一段话'].join('\n\n'), 40);
  assert.ok(parts.length > 1);
  assert.ok(parts.every(part => Array.from(part).length <= 40));
  assert.ok(parts.some(part => part === list));
  assert.equal(parts.join('\n\n'), ['开头一段话', list, '结尾一段话'].join('\n\n'));
});
test('a code block that has to be split keeps its fences in every part', () => {
  const code = ['```python', ...Array.from({ length: 12 }, (_, i) => `print(${i})`), '```'].join('\n');
  const parts = chunks(code, 60);
  assert.ok(parts.length > 1);
  for (const part of parts) {
    assert.ok(part.startsWith('```python\n') && part.endsWith('\n```'));
    assert.ok(Array.from(part).length <= 60);
  }
  assert.equal(parts.map(part => part.split('\n').slice(1, -1).join('\n')).join('\n'), code.split('\n').slice(1, -1).join('\n'));
});
test('blank lines inside a code block do not split it', () => {
  const code = '```\na\n\nb\n```';
  assert.deepEqual(chunks(`说明\n\n${code}`, 1500), [`说明\n\n${code}`]);
  assert.deepEqual(chunks(`说明\n\n${code}`, 12), ['说明', code]);
});
