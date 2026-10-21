import { randomBytes, createHash, createCipheriv, createDecipheriv } from 'node:crypto';
import { request, jsonBody, bytes, Fault, imageMime } from './http.js';

export const API = 'https://ilinkai.weixin.qq.com';
export const CDN = 'https://novac2c.cdn.weixin.qq.com/c2c';
export function weixinUrl(value) {
  let u;
  try { u = new URL(value); } catch { throw new Fault('INVALID_WEIXIN_HOST'); }
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !(u.hostname === 'weixin.qq.com' || u.hostname.endsWith('.weixin.qq.com'))) throw new Fault('INVALID_WEIXIN_HOST');
  return u;
}
export function aesKey(value) {
  const raw = Buffer.from(value, 'base64');
  if (raw.length === 16) return raw;
  if (raw.length === 32 && /^[a-f\d]{32}$/i.test(raw.toString())) return Buffer.from(raw.toString(), 'hex');
  throw new Fault('INVALID_MEDIA_KEY');
}
export function encryptMedia(data, key) {
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
export function decryptMedia(data, key) {
  const cipher = createDecipheriv('aes-128-ecb', key, null);
  try { return Buffer.concat([cipher.update(data), cipher.final()]); }
  catch { throw new Fault('INVALID_MEDIA'); }
}
export class Weixin {
  constructor(fetcher = fetch) { this.fetcher = fetcher; }
  headers(poll = false, token) {
    return { 'iLink-App-Id': 'bot', 'iLink-App-ClientVersion': String(0x02040a), ...(!poll ? {
      'Content-Type': 'application/json', AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64'),
      ...(token ? { Authorization: `Bearer ${token}` } : {})
    } : {}) };
  }
  async call(bot, endpoint, body, timeout = 20000) {
    const base = weixinUrl(bot.baseurl).origin;
    const res = await request(base + '/ilink/bot/' + endpoint, {
      method: 'POST', headers: this.headers(false, bot.bot_token),
      body: JSON.stringify({ ...body, base_info: { channel_version: '2.4.10', bot_agent: 'YeeMagineWorker/0.1.0' } })
    }, timeout, this.fetcher);
    if (!res.ok) { await res.body?.cancel(); throw new Fault('WEIXIN_HTTP_' + res.status); }
    const data = await jsonBody(res);
    if (data.ret === -14 || data.errcode === -14) throw new Fault('WEIXIN_COOLDOWN');
    if ((data.ret != null && data.ret !== 0) || (data.errcode != null && data.errcode !== 0)) throw new Fault('WEIXIN_API_ERROR');
    return data;
  }
  async qr() {
    const res = await request(API + '/ilink/bot/get_bot_qrcode?bot_type=3', {
      method: 'POST', headers: this.headers(), body: JSON.stringify({ local_token_list: [] })
    }, 20000, this.fetcher);
    if (!res.ok) throw new Fault('WEIXIN_QR_FAILED');
    const data = await jsonBody(res);
    if (!data.qrcode || !data.qrcode_img_content) throw new Fault('WEIXIN_QR_FAILED');
    return data;
  }
  async scan(scan, code) {
    const url = new URL('/ilink/bot/get_qrcode_status', weixinUrl(scan.baseurl).origin);
    url.searchParams.set('qrcode', scan.qrcode);
    if (code) url.searchParams.set('verify_code', code);
    const res = await request(url, { headers: this.headers(true) }, 40000, this.fetcher);
    if (!res.ok) throw new Fault('WEIXIN_QR_FAILED');
    return jsonBody(res);
  }
  updates(bot, cursor) { return this.call(bot, 'getupdates', { get_updates_buf: cursor || '' }, 40000); }
  send(bot, route, item, id) {
    return this.call(bot, 'sendmessage', { msg: { from_user_id: '', to_user_id: route.toUserId, context_token: route.contextToken,
      client_id: id, message_type: 2, message_state: 2, item_list: [item] } });
  }
  async download(item) {
    const media = item.media;
    if (!media || (!media.full_url && !media.encrypt_query_param)) throw new Fault('INVALID_MEDIA');
    const url = media.full_url || `${CDN}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`;
    const res = await request(weixinUrl(url), {}, 20000, this.fetcher);
    if (!res.ok) throw new Fault('MEDIA_DOWNLOAD_FAILED');
    let data = Buffer.from(await bytes(res, 8 * 1024 * 1024 + 16));
    const key = item.aeskey ? (/^[a-f\d]{32}$/i.test(item.aeskey) ? Buffer.from(item.aeskey, 'hex') : null) : media.aes_key ? aesKey(media.aes_key) : null;
    if (item.aeskey && !key) throw new Fault('INVALID_MEDIA_KEY');
    if (key) data = decryptMedia(data, key);
    if (data.length > 8 * 1024 * 1024) throw new Fault('BODY_TOO_LARGE', 413);
    return { data, mime: imageMime(data) };
  }
  async upload(bot, route, data) {
    imageMime(data);
    const key = randomBytes(16), filekey = randomBytes(16).toString('hex');
    const encrypted = encryptMedia(data, key);
    const ticket = await this.call(bot, 'getuploadurl', { filekey, media_type: 1, to_user_id: route.toUserId,
      rawsize: data.length, rawfilemd5: createHash('md5').update(data).digest('hex'), filesize: encrypted.length,
      no_need_thumb: true, aeskey: key.toString('hex') });
    if (!ticket.upload_full_url && !ticket.upload_param) throw new Fault('MEDIA_UPLOAD_FAILED');
    const url = ticket.upload_full_url || `${CDN}/upload?encrypted_query_param=${encodeURIComponent(ticket.upload_param)}&filekey=${filekey}`;
    const res = await request(weixinUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted }, 20000, this.fetcher);
    const parameter = res.headers.get('x-encrypted-param');
    await res.body?.cancel();
    if (res.status !== 200 || !parameter) throw new Fault('MEDIA_UPLOAD_FAILED');
    return { type: 2, image_item: { media: { encrypt_query_param: parameter, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } };
  }
}
