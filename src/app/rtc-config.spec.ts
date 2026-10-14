import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadRtcConfig } from './rtc-config';
import { MultiplayerSession } from './multiplayer';

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
test('a member applies the server\'s TURN servers (ice) before creating any peer, keeps the STUN servers, and gets fresh ones on Reconnect; without ice nothing changes', async () => {
  const stun = { urls: ['stun:stun.cloudflare.com:3478'] }, turn = (n: number) => [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: `user-${n}`, credential: `secret-${n}` }];
  const configs: RTCConfiguration[] = [], sockets: any[] = [];
  class FakeSocket { static OPEN = 1; readyState = 1; sent: any[] = []; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void; onerror?: () => void;
    constructor() { sockets.push(this); } send(raw: string) { this.sent.push(JSON.parse(raw)); } close() { this.readyState = 3; } }
  class FakePeer { localDescription = { type: 'offer', sdp: '' }; remoteDescription = null; onicecandidate = null; onconnectionstatechange = null; ondatachannel = null;
    constructor(config: RTCConfiguration) { configs.push(config); } createDataChannel() { return {}; } async createOffer() { return {}; } async setLocalDescription() {} close() {} }
  const globals = globalThis as any, saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, RTCPeerConnection: globals.RTCPeerConnection, location: globals.location };
  Object.assign(globals, { fetch: async () => new Response(JSON.stringify({ iceServers: [stun] }), { headers: { 'content-type': 'application/json' } }), WebSocket: FakeSocket, RTCPeerConnection: FakePeer, location: { protocol: 'http:', host: 'test' } });
  const deliver = (socket: any, ...messages: object[]) => { for (const msg of messages) socket.onmessage({ data: JSON.stringify(msg) }); };
  const room = (host: string, guest: string) => ({ name: 'Relay', code: '123456', kind: 'team', challenge: null, visibility: 'network', host, started: false, humanRoles: [], members: [{ id: host, role: null, nickname: '', online: true, connection: 1 }, { id: guest, role: null, nickname: '', online: true, connection: 1 }] });
  try {
    // A guest: its peer to the host is created by the host's first signal, after ice, session and room.
    const guest = new MultiplayerSession(() => {});
    await guest.enter('join', '', '123456');
    let socket = sockets.at(-1); socket.onopen();
    deliver(socket, { type: 'welcome', id: 'g' }, { type: 'ice', iceServers: turn(1) }, { type: 'session', id: 'g', token: 't' }, { type: 'room', room: room('h', 'g') }, { type: 'signal', from: 'h', signal: { candidate: { candidate: 'c' } } });
    assert.deepEqual(configs.at(-1)!.iceServers, [stun, ...turn(1)]);
    // Reconnect opens a new connection: the STUN list is reloaded and the new credentials replace the old ones.
    await guest.resume({ version: 1, token: 't', id: 'g', room: room('h', 'g') as any, savedAt: Date.now(), game: null, pending: {}, challengeGames: [], leaderboard: [], challengeStarted: 0 });
    socket = sockets.at(-1); socket.onopen();
    assert.equal(socket.sent[0].type, 'resume');
    deliver(socket, { type: 'welcome', id: 'x' }, { type: 'ice', iceServers: turn(2) }, { type: 'session', id: 'g', token: 't' }, { type: 'room', room: room('h', 'g') }, { type: 'signal', from: 'h', signal: { candidate: { candidate: 'c' } } });
    assert.deepEqual(configs.at(-1)!.iceServers, [stun, ...turn(2)]);
    // The host gets them like everyone else: its offer to a guest is created while the room message is handled.
    const host = new MultiplayerSession(() => {});
    await host.enter('create', 'Relay');
    socket = sockets.at(-1); socket.onopen();
    deliver(socket, { type: 'welcome', id: 'h' }, { type: 'ice', iceServers: turn(3) }, { type: 'session', id: 'h', token: 't' }, { type: 'room', room: room('h', 'g') });
    assert.deepEqual(configs.at(-1)!.iceServers, [stun, ...turn(3)]);
    // No ice message (no Cloudflare TURN, or its request failed): the configuration from /rtc-config, as before. Malformed ice is ignored.
    const plain = new MultiplayerSession(() => {});
    await plain.enter('create', 'Relay');
    socket = sockets.at(-1); socket.onopen();
    deliver(socket, { type: 'welcome', id: 'h' }, { type: 'ice', iceServers: [{ urls: [] }] }, { type: 'session', id: 'h', token: 't' }, { type: 'room', room: room('h', 'g') });
    assert.deepEqual(configs.at(-1), { iceServers: [stun] });
    assert.equal(configs.length, 4);
  } finally { Object.assign(globals, saved); }
});
test('a late ice restarts ICE on a peer that failed without TURN (or fails later), the other side answers the new offer, and a peer that fails with TURN reports the failure (except after the reveal)', async () => {
  const stun = { urls: ['stun:stun.cloudflare.com:3478'] }, turn = [{ urls: ['turns:turn.cloudflare.com:443?transport=tcp'], username: 'user-1', credential: 'secret-1' }];
  const pcs: FakePeer[] = [], sockets: any[] = [];
  class FakeSocket { static OPEN = 1; readyState = 1; sent: any[] = []; onopen?: () => void; onmessage?: (event: { data: string }) => void; onclose?: (event: { code: number }) => void; onerror?: () => void;
    constructor() { sockets.push(this); } send(raw: string) { this.sent.push(JSON.parse(raw)); } close() { this.readyState = 3; } }
  class FakePeer { connectionState = 'connecting'; localDescription: any = null; remoteDescription: any = null; offers: any[] = []; configs: RTCConfiguration[] = []; onicecandidate = null; onconnectionstatechange: (() => void) | null = null; ondatachannel = null;
    constructor(config: RTCConfiguration) { this.configs.push(config); pcs.push(this); } setConfiguration(config: RTCConfiguration) { this.configs.push(config); } createDataChannel() { return {}; }
    async createOffer(options?: RTCOfferOptions) { this.offers.push(options ?? {}); return { type: 'offer', sdp: `offer-${this.offers.length}` }; } async createAnswer() { return { type: 'answer', sdp: 'answer' }; }
    async setLocalDescription(description: any) { this.localDescription = description; } async setRemoteDescription(description: any) { this.remoteDescription = description; } async addIceCandidate() {} close() {}
    fail() { this.connectionState = 'failed'; this.onconnectionstatechange!(); } }
  const globals = globalThis as any, saved = { fetch: globals.fetch, WebSocket: globals.WebSocket, RTCPeerConnection: globals.RTCPeerConnection, location: globals.location };
  Object.assign(globals, { fetch: async () => new Response(JSON.stringify({ iceServers: [stun] }), { headers: { 'content-type': 'application/json' } }), WebSocket: FakeSocket, RTCPeerConnection: FakePeer, location: { protocol: 'http:', host: 'test' } });
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const deliver = async (socket: any, ...messages: object[]) => { for (const msg of messages) socket.onmessage({ data: JSON.stringify(msg) }); await settle(); };
  const member = (id: string) => ({ id, role: null, nickname: '', online: true, connection: 1 });
  const room = (...ids: string[]) => ({ name: 'Relay', code: '123456', kind: 'team', challenge: null, visibility: 'network', host: 'h', started: false, humanRoles: [], members: ids.map(member) });
  const signals = (socket: any) => socket.sent.filter((m: any) => m.type === 'signal' && m.signal.description);
  const failure = 'WebRTC connection failed. A TURN relay may be needed for this network.';
  try {
    // The host's peer to a guest exists before its TURN servers arrive (none was issued in time), and fails.
    const host = new MultiplayerSession(() => {});
    await host.enter('create', 'Relay');
    let socket = sockets.at(-1); socket.onopen();
    await deliver(socket, { type: 'welcome', id: 'h' }, { type: 'session', id: 'h', token: 't' }, { type: 'room', room: room('h') }, { type: 'room', room: room('h', 'g') });
    const hostPeer = pcs.at(-1)!;
    assert.deepEqual(hostPeer.configs, [{ iceServers: [stun] }]); assert.deepEqual(signals(socket).map((m: any) => m.signal.description.sdp), ['offer-1']);
    hostPeer.fail();
    assert.equal(host.error, failure);
    // The late ice: the failed peer gathers again with STUN and TURN and sends an ICE-restart offer instead of staying failed.
    await deliver(socket, { type: 'ice', iceServers: turn });
    assert.deepEqual(hostPeer.configs.at(-1), { iceServers: [stun, ...turn] }); assert.deepEqual(hostPeer.offers.at(-1), { iceRestart: true });
    assert.deepEqual(signals(socket).at(-1), { type: 'signal', to: 'g', signal: { description: { type: 'offer', sdp: 'offer-2' } } });
    // Failing again with TURN reports the failure, without another restart.
    hostPeer.fail(); await settle();
    assert.equal(hostPeer.offers.length, 2); assert.equal(host.error, failure);

    // A guest's peer (created on the host's offer) is still connecting when the late ice arrives: nothing restarts until it fails.
    const guest = new MultiplayerSession(() => {});
    await guest.enter('join', '', '123456');
    socket = sockets.at(-1); socket.onopen();
    await deliver(socket, { type: 'welcome', id: 'g' }, { type: 'session', id: 'g', token: 't' }, { type: 'room', room: room('h', 'g') }, { type: 'signal', from: 'h', signal: { description: { type: 'offer', sdp: 'host-offer' } } });
    const guestPeer = pcs.at(-1)!;
    assert.deepEqual(signals(socket).at(-1).signal.description, { type: 'answer', sdp: 'answer' });
    await deliver(socket, { type: 'ice', iceServers: turn });
    assert.deepEqual([guestPeer.configs.length, guestPeer.offers.length], [1, 0]);
    guestPeer.fail(); await settle();
    assert.deepEqual(guestPeer.configs.at(-1), { iceServers: [stun, ...turn] }); assert.deepEqual(guestPeer.offers, [{ iceRestart: true }]);
    assert.deepEqual(signals(socket).at(-1), { type: 'signal', to: 'h', signal: { description: { type: 'offer', sdp: 'offer-1' } } });
    assert.equal(guest.error, '');
    // The host answers a guest's restart offer on the existing peer.
    socket = sockets[0]; const peers = pcs.length;
    await deliver(socket, { type: 'signal', from: 'g', signal: { description: { type: 'offer', sdp: 'guest-restart' } } });
    assert.deepEqual([hostPeer.remoteDescription.sdp, signals(socket).at(-1).signal.description.type, pcs.length], ['guest-restart', 'answer', peers]);
    // After the reveal the server revokes relay credentials, so a drop is expected and not reported.
    (guest as any).revealedByHost = true;
    guestPeer.fail();
    assert.equal(guest.error, '');
  } finally { Object.assign(globals, saved); }
});
