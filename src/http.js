export class Fault extends Error {
  constructor(code, status = 502) { super(code); this.code = code; this.status = status; }
}
export function origin(value) {
  try {
    const u = new URL(value);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/') return null;
    return u.origin;
  } catch { return null; }
}
export function config(env) {
  const missing = [];
  if (!origin(env.PLATFORM_BASE_URL)) missing.push('PLATFORM_BASE_URL');
  if (env.PUBLIC_BASE_URL && !origin(env.PUBLIC_BASE_URL)) missing.push('PUBLIC_BASE_URL');
  for (const name of ['PLATFORM_USER_ID', 'OAUTH_CLIENT_ID', 'OAUTH_CLIENT_SECRET']) if (!env[name]?.trim()) missing.push(name);
  if (env.CREDENTIAL_ENCRYPTION_KEY && !/^[a-f\d]{64}$/i.test(env.CREDENTIAL_ENCRYPTION_KEY)) missing.push('CREDENTIAL_ENCRYPTION_KEY');
  return missing;
}
export async function bytes(response, max = 8 * 1024 * 1024) {
  if (Number(response.headers.get('content-length')) > max) { await response.body?.cancel(); throw new Fault('BODY_TOO_LARGE', 413); }
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader(), chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > max) throw new Fault('BODY_TOO_LARGE', 413);
      chunks.push(value);
    }
  } catch (e) { await reader.cancel().catch(() => {}); throw e; }
  const out = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.length; }
  return out;
}
export async function jsonBody(response, max = 2 * 1024 * 1024) {
  try { return JSON.parse(new TextDecoder().decode(await bytes(response, max))); }
  catch (e) { if (e instanceof Fault) throw e; throw new Fault('INVALID_JSON', 400); }
}
export async function request(url, init = {}, timeout = 20000, fetcher = fetch) {
  try {
    // workerd 不支持 redirect: 'error'；手动接收并拒绝跳转，避免转发凭证。
    const response = await fetcher(url, { ...init, redirect: 'manual', signal: AbortSignal.timeout(timeout) });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      await response.body?.cancel();
      throw new Fault('NETWORK_REDIRECT_ERROR', 502);
    }
    return response;
  }
  catch (e) {
    if (e instanceof Fault) throw e;
    // 只返回固定分类，不暴露异常中的 URL、凭证或响应正文。
    const reason = `${e?.name || ''} ${e?.message || ''} ${e?.cause?.code || ''} ${e?.cause?.message || ''}`;
    const code = /timeout|timed out|abort/i.test(reason) ? 'NETWORK_TIMEOUT'
      : /certificate|cert_|tls|ssl/i.test(reason) ? 'NETWORK_TLS_ERROR'
      : /dns|enotfound|eai_again|resolve.*host/i.test(reason) ? 'NETWORK_DNS_ERROR'
      : /redirect/i.test(reason) ? 'NETWORK_REDIRECT_ERROR'
      : /refused|econnrefused/i.test(reason) ? 'NETWORK_CONNECTION_REFUSED'
      : /connection.*(?:lost|reset|closed)|econnreset|socket/i.test(reason) ? 'NETWORK_CONNECTION_LOST'
      : 'NETWORK_ERROR';
    throw new Fault(code, 502);
  }
}
export const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
export function safeCode(e) { return e instanceof Fault && /^[A-Za-z0-9_-]{1,80}$/.test(e.code) ? e.code : 'INTERNAL_ERROR'; }
export const imageMime = (data) => {
  const b = Buffer.from(data);
  if (b.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg';
  if (b.subarray(0, 6).toString() === 'GIF87a' || b.subarray(0, 6).toString() === 'GIF89a') return 'image/gif';
  if (b.subarray(0, 4).toString() === 'RIFF' && b.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw new Fault('UNSUPPORTED_IMAGE', 415);
};
