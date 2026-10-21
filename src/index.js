import { DurableObject } from 'cloudflare:workers';
import { Connection } from './connection.js';
import { State } from './state.js';
import { json, Fault, safeCode } from './http.js';

const security = {
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'"
};
export class ConnectionDO extends DurableObject {
  constructor(ctx, env) { super(ctx, env); this.connection = new Connection(new State(ctx.storage), env); }
  async fetch(request) {
    try { return await this.connection.handle(request); }
    catch (e) { return json({ error: safeCode(e) }, e instanceof Fault ? e.status : 500); }
  }
  alarm() { return this.connection.alarm(); }
  wake() { return this.connection.wake(); }
}
export default {
  async fetch(request, env) {
    const path = new URL(request.url).pathname;
    let response;
    try {
      if (path.startsWith('/api/') || path.startsWith('/auth/')) response = await env.CONNECTION.getByName('connection').fetch(request);
      else if (['/', '/index.html', '/app.js', '/style.css'].includes(path) && ['GET', 'HEAD'].includes(request.method)) response = await env.ASSETS.fetch(request);
      else response = json({ error: 'NOT_FOUND' }, 404);
    } catch { response = json({ error: 'SERVICE_UNAVAILABLE' }, 503); }
    response = new Response(response.body, response);
    for (const [key, value] of Object.entries(security)) response.headers.set(key, value);
    return response;
  },
  async scheduled(_event, env) { await env.CONNECTION.getByName('connection').wake(); }
};
