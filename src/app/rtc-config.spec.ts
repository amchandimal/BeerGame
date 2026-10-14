import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRtcConfig } from './rtc-config';

function respond(body: string, contentType: string, status = 200): typeof fetch {
  return async () => new Response(body, { status, headers: { 'content-type': contentType } });
}
test('HTML fallback gives startup instructions instead of a JSON syntax error', async () => {
  await assert.rejects(loadRtcConfig(respond('<!doctype html><html></html>', 'text/html')), error => {
    assert.match((error as Error).message, /web page instead of JSON/);
    assert.match((error as Error).message, /npm start/);
    assert.doesNotMatch((error as Error).message, /Unexpected token/);
    return true;
  });
});
test('valid ICE settings load and request JSON explicitly', async () => {
  const config = { iceServers: [{ urls: ['stun:example.test:3478'] }, { urls: 'turn:example.test:3478', username: 'test', credential: 'test' }] };
  const request: typeof fetch = async (url, init) => {
    assert.equal(url, '/rtc-config');
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    return new Response(JSON.stringify(config), { headers: { 'content-type': 'application/json; charset=utf-8' } });
  };
  assert.deepEqual(await loadRtcConfig(request), config);
});
test('unavailable service and malformed JSON have actionable diagnostics', async () => {
  await assert.rejects(loadRtcConfig(respond('Unavailable', 'text/plain', 502)), /HTTP 502/);
  await assert.rejects(loadRtcConfig(respond('<html>', 'application/json')), /contains invalid JSON/);
  await assert.rejects(loadRtcConfig(async () => { throw new TypeError('Failed to fetch'); }), /Cannot reach the multiplayer signaling service/);
});
test('a JSON response from the wrong API is not treated as RTC configuration', async () => {
  for (const config of [{}, { iceServers: [null] }, { iceServers: [{ urls: [] }] }]) {
    await assert.rejects(loadRtcConfig(respond(JSON.stringify(config), 'application/json')), /missing valid ICE/);
  }
});
