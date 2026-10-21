import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { Weixin, aesKey, encryptMedia, decryptMedia } from './src/weixin.js';

export default { async test() {
  // AES-128 标准向量验证密文，整块明文仍须增加完整 PKCS#7 填充块。
  const key = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  const plain = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const encrypted = encryptMedia(plain, key);
  assert.equal(encrypted.subarray(0, 16).toString('hex'), '69c4e0d86a7b0430d8cdb78070b4c55a');
  assert.equal(encrypted.length, 32);
  assert.deepEqual(decryptMedia(encrypted, key), plain);
  for (const size of [0, 1, 15, 16, 17, 32, 1024]) {
    const data = Buffer.alloc(size, 7), ciphertext = encryptMedia(data, key);
    assert.equal(ciphertext.length, (Math.floor(size / 16) + 1) * 16);
    assert.deepEqual(decryptMedia(ciphertext, key), data);
  }

  // 完整走上传申请、CDN 上传和下载解密；仅模拟网络，不调用生图或微信服务。
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');
  const calls = []; let ticket, ciphertext;
  const wx = new Weixin(async (url, init) => {
    const u = new URL(url); calls.push(u.pathname);
    if (u.pathname === '/ilink/bot/getuploadurl') {
      ticket = JSON.parse(init.body);
      assert.equal(ticket.rawsize, png.length);
      assert.equal(ticket.rawfilemd5, createHash('md5').update(png).digest('hex'));
      assert.equal(ticket.media_type, 1);
      return Response.json({ ret: 0, upload_param: 'upload-ticket' });
    }
    if (u.pathname === '/c2c/upload') {
      ciphertext = Buffer.from(init.body);
      assert.equal(ciphertext.length, ticket.filesize);
      assert.deepEqual(decryptMedia(ciphertext, Buffer.from(ticket.aeskey, 'hex')), png);
      return new Response('', { headers: { 'x-encrypted-param': 'download-ticket' } });
    }
    assert.equal(u.pathname, '/c2c/download');
    assert.equal(u.searchParams.get('encrypted_query_param'), 'download-ticket');
    return new Response(ciphertext);
  });
  const item = await wx.upload({ baseurl: 'https://ilinkai.weixin.qq.com', bot_token: 'test-token' }, { toUserId: 'test-user' }, new Uint8Array(png));
  assert.equal(item.type, 2);
  assert.equal(item.image_item.media.encrypt_type, 1);
  assert.equal(aesKey(item.image_item.media.aes_key).toString('hex'), ticket.aeskey);
  assert.equal(item.image_item.mid_size, ciphertext.length);
  const downloaded = await wx.download(item.image_item);
  assert.equal(downloaded.mime, 'image/png');
  assert.deepEqual(downloaded.data, png);
  assert.deepEqual(calls, ['/ilink/bot/getuploadurl', '/c2c/upload', '/c2c/download']);
} };
