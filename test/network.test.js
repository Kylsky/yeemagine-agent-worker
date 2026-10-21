import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from '../src/http.js';
import { Platform } from '../src/platform.js';

test('network failures use bounded categories without leaking exception details', async () => {
  for (const [message, code] of [
    ['certificate verify failed','NETWORK_TLS_ERROR'],
    ['DNS lookup failed','NETWORK_DNS_ERROR'],
    ['unexpected redirect','NETWORK_REDIRECT_ERROR'],
    ['connection refused','NETWORK_CONNECTION_REFUSED'],
    ['Network connection lost.','NETWORK_CONNECTION_LOST'],
    ['operation timed out','NETWORK_TIMEOUT'],
    ['unknown failure','NETWORK_ERROR']
  ]) {
    await assert.rejects(request('https://platform.example', {}, 1000, async () => {
      throw new Error(message+' secret=do-not-expose');
    }), {code, message:code});
  }
});
test('platform distinguishes token exchange and identity lookup network failures', async () => {
  const p = new Platform({PLATFORM_BASE_URL:'https://platform.example'}, async () => {
    throw new Error('certificate verification failed');
  });
  await assert.rejects(p.token({}), {code:'PLATFORM_TOKEN_NETWORK_TLS_ERROR'});
  await assert.rejects(p.api('secret','/oauth/me'), {code:'PLATFORM_IDENTITY_NETWORK_TLS_ERROR'});
});

test('workerd-compatible requests reject redirects without forwarding credentials', async () => {
  for (const status of [301,302,303,307,308]) {
    let calls = 0, cancelled = false;
    const fetcher = async (_url, init) => {
      calls++;
      if (init.redirect !== 'manual') throw new TypeError('Invalid redirect value');
      return new Response(new ReadableStream({cancel() {cancelled=true;}}), {
        status, headers:{Location:'https://other.example/collect'}
      });
    };
    await assert.rejects(request('https://platform.example/oauth/token', {
      method:'POST', body:'client_secret=private'
    }, 1000, fetcher), {code:'NETWORK_REDIRECT_ERROR'});
    assert.equal(calls,1);
    assert.equal(cancelled,true);
  }
  const response = await request('https://platform.example/oauth/token', {}, 1000, async (_url, init) => {
    assert.equal(init.redirect,'manual');
    return Response.json({error:'invalid_client'}, {status:401});
  });
  assert.equal(response.status,401);
});
