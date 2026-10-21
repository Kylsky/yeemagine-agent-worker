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
  // ECB 不使用 IV；workerd 的 Node 兼容层拒绝 null，使用零长度 Buffer。
  const cipher = createCipheriv('aes-128-ecb', key, Buffer.alloc(0));
  return Buffer.concat([cipher.update(data), cipher.final()]);
}
export function decryptMedia(data, key) {
  const cipher = createDecipheriv('aes-128-ecb', key, Buffer.alloc(0));
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
    // 微信消息 ID 可能是 uint64；使用原始数字文本，不能先转 Number 再转字符串。
    let data;
    try {
      data = JSON.parse(new TextDecoder().decode(await bytes(res, 2 * 1024 * 1024)), (key, value, context) => {
        if (['message_id', 'msg_id', 'svr_id'].includes(key) && typeof value === 'number') {
          if (context?.source && /^\d+$/.test(context.source)) return context.source;
          if (!Number.isSafeInteger(value)) throw new Fault('INVALID_WEIXIN_MESSAGE_ID');
          return String(value);
        }
        return value;
      });
    } catch (e) { if (e instanceof Fault) throw e; throw new Fault('INVALID_JSON', 400); }
    if (data.ret === -14 || data.errcode === -14) throw new Fault('WEIXIN_COOLDOWN');
    // 带上微信返回码，排查发送失败时能看出是哪一类错误。
    if ((data.ret != null && data.ret !== 0) || (data.errcode != null && data.errcode !== 0)) throw new Fault(`WEIXIN_API_ERROR_${Number(data.errcode || data.ret) || 'UNKNOWN'}`);
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
    // 与官方插件一致：扫码状态是 35 秒长轮询，超时或网络抖动都当作“还在等待”，由页面继续查询。
    let res;
    try { res = await request(url, { headers: this.headers(true) }, 35000, this.fetcher); }
    catch (e) { if (String(e.code).startsWith('NETWORK_')) return { status: 'wait' }; throw e; }
    if (!res.ok) throw new Fault('WEIXIN_QR_FAILED');
    return jsonBody(res);
  }
  // timeout 取服务端上次建议的 longpolling_timeout_ms（默认 35 秒），本地多留 5 秒，避免服务端刚好返回时被中止。
  async updates(bot, cursor, timeout = 35000) {
    try { return await this.call(bot, 'getupdates', { get_updates_buf: cursor || '' }, timeout + 5000); }
    catch (e) {
      // 长轮询没有新消息时超时是正常状态，不触发指数退避。
      if (e.code === 'NETWORK_TIMEOUT') return { msgs: [], get_updates_buf: cursor || '' };
      throw e;
    }
  }
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
    if (!ticket.upload_full_url && !ticket.upload_param) throw new Fault('MEDIA_UPLOAD_NO_URL');
    const url = ticket.upload_full_url || `${CDN}/upload?encrypted_query_param=${encodeURIComponent(ticket.upload_param)}&filekey=${filekey}`;
    // 官方插件上传不设超时；Worker 在境外，往国内 CDN 传几 MB 常超过 20 秒，这里放宽到 90 秒。
    const res = await request(weixinUrl(url), { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: encrypted }, 90000, this.fetcher);
    const parameter = res.headers.get('x-encrypted-param');
    await res.body?.cancel();
    // 与官方插件一致：4xx 是被拒绝、重试无用；5xx 和缺少下载参数按临时错误重试。
    if (res.status >= 400 && res.status < 500) throw new Fault(`MEDIA_UPLOAD_REJECTED_${res.status}`, 400);
    if (res.status !== 200) throw new Fault(`MEDIA_UPLOAD_HTTP_${res.status}`);
    if (!parameter) throw new Fault('MEDIA_UPLOAD_NO_PARAM');
    return { type: 2, image_item: { media: { encrypt_query_param: parameter, aes_key: Buffer.from(key.toString('hex')).toString('base64'), encrypt_type: 1 }, mid_size: encrypted.length } };
  }
}
