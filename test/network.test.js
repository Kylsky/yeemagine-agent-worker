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
