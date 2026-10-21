import { request, jsonBody, Fault, bytes } from './http.js';
export class Platform {
  constructor(env, fetcher = fetch) { this.env = env; this.fetcher = fetcher; }
  async raw(path, init = {}) {
    return request(new URL(path, this.env.PLATFORM_BASE_URL), init, 20000, this.fetcher);
  }
  async decode(res) {
    const data = await jsonBody(res);
    if (!res.ok) throw new Fault(data.code || data.error || `PLATFORM_HTTP_${res.status}`, res.status);
    return data;
  }
  async token(fields, endpoint = '/oauth/token') {
    return this.decode(await this.raw(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...fields, client_id: this.env.OAUTH_CLIENT_ID, client_secret: this.env.OAUTH_CLIENT_SECRET }) }));
  }
  async api(token, path, body, mode = 'json') {
    const headers = { Authorization: `Bearer ${token}` };
    let payload;
    if (body instanceof FormData) payload = body;
    else if (body !== undefined) { headers['Content-Type'] = 'application/json'; payload = JSON.stringify(body); }
    const res = await this.raw(path, { method: body === undefined ? 'GET' : 'POST', headers, body: payload });
    if (mode === 'bytes' && res.ok) return bytes(res);
    return this.decode(res);
  }
}
