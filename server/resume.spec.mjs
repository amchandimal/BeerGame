import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSignalingServer } from './index.mjs';

async function connect_(server) {
  const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`);
  const messages = [];
  socket.on('message', raw => messages.push(JSON.parse(raw)));
  const receive = async predicate => {
    const end = Date.now() + 3000;
    while (Date.now() < end) {
      const i = messages.findIndex(predicate);
      if (i !== -1) return messages.splice(i, 1)[0];
      await new Promise(r => setTimeout(r, 5));
    }
    throw new Error('Timed out waiting for signaling response');
  };
  await receive(m => m.type === 'welcome');
  return { socket, receive, send: message => socket.send(JSON.stringify(message)) };
}

test('private resume credentials preserve identities and roles, expire, and invalidate on completion/leave', async () => {
  const { server, wss } = createSignalingServer({ reconnectMs: 150 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connect = () => connect_(server);
  try {
    const host = await connect();
    host.send({ type: 'create', name: 'Resume test' });
    const credential = await host.receive(m => m.type === 'session');
    const { room } = await host.receive(m => m.type === 'room');
    assert.ok(!JSON.stringify(room).includes(credential.token));
    host.send({ type: 'nickname', nickname: 'Creator' });
    host.send({ type: 'claim', role: 'Retailer' });
    host.send({ type: 'started' });
    await host.receive(m => m.type === 'room' && m.room.started);
    const stranger = await connect();
    stranger.send({ type: 'resume', code: room.code, token: 'wrong' });
    await stranger.receive(m => m.type === 'resume-unavailable');
    stranger.send({ type: 'check', code: room.code, token: 'wrong' });
    assert.equal((await stranger.receive(m => m.type === 'available')).available, false);
    const resumed = await connect();
    resumed.send({ type: 'resume', code: room.code, token: credential.token });
    assert.equal((await resumed.receive(m => m.type === 'session')).id, credential.id);
    const state = (await resumed.receive(m => m.type === 'room')).room;
    assert.equal(state.host, credential.id);
    assert.equal(state.started, true);
    assert.equal(state.members[0].role, 'Retailer');
    assert.equal(state.members[0].nickname, 'Creator');
    assert.equal(state.members[0].connection, 2);
    resumed.send({ type: 'finished' });
    // Wait for a subsequent response on this socket before checking completion.
    resumed.send({ type: 'started' });
    await resumed.receive(m => m.type === 'error');
    stranger.send({ type: 'check', code: room.code, token: credential.token });
    assert.equal((await stranger.receive(m => m.type === 'available')).available, false);
    resumed.send({ type: 'leave' });
    resumed.send({ type: 'create', name: 'Expiring room' });
    const next = await resumed.receive(m => m.type === 'session');
    const expiring = (await resumed.receive(m => m.type === 'room' && m.room.name === 'Expiring room')).room;
    resumed.socket.close(); await once(resumed.socket, 'close');
    await new Promise(r => setTimeout(r, 180));
    stranger.send({ type: 'resume', code: expiring.code, token: next.token });
    await stranger.receive(m => m.type === 'resume-unavailable');
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('a finished room admits its players while the host is online so they receive the results, then is cleaned up; a host resuming to leave ends the game for everyone', async () => {
  const { server, wss } = createSignalingServer({ finishedMs: 600 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const connect = () => connect_(server);
  async function team(name) {
    const host = await connect(), guest = await connect();
    host.send({ type: 'create', name });
    const hostSession = await host.receive(m => m.type === 'session');
    const { room } = await host.receive(m => m.type === 'room');
    host.send({ type: 'nickname', nickname: 'Host' }); host.send({ type: 'claim', role: 'Retailer' });
    guest.send({ type: 'join', code: room.code });
    const guestSession = await guest.receive(m => m.type === 'session');
    guest.send({ type: 'nickname', nickname: 'Guest' }); guest.send({ type: 'claim', role: 'Wholesaler' });
    await host.receive(m => m.type === 'room' && m.room.members.length === 2 && m.room.members.every(p => p.role && p.nickname));
    host.send({ type: 'started' });
    await guest.receive(m => m.type === 'room' && m.room.started);
    return { host, guest, room, hostSession, guestSession };
  }
  const check = async (client, code, token) => { client.send({ type: 'check', code, token }); return client.receive(m => m.type === 'available'); };
  try {
    // The guest's connection is closed when the host finishes, as during a refresh at the last week.
    const { host, guest, room, hostSession, guestSession } = await team('Late reveal');
    guest.socket.close(); await once(guest.socket, 'close');
    host.send({ type: 'finished' });
    const checker = await connect();
    assert.deepEqual(await check(checker, room.code, guestSession.token), { type: 'available', available: true });
    assert.deepEqual(await check(checker, room.code, hostSession.token), { type: 'available', available: false, reason: 'finished' }, 'the host never resumes a finished room');
    const back = await connect();
    back.send({ type: 'resume', code: room.code, token: guestSession.token });
    assert.equal((await back.receive(m => m.type === 'session')).id, guestSession.id);
    await host.receive(m => m.type === 'room' && m.room.members.every(p => p.online)); // The host sees the player again and sends the final snapshot over WebRTC.
    back.socket.close(); await once(back.socket, 'close');
    // Without the host nobody can send the results.
    host.socket.close(); await once(host.socket, 'close');
    assert.deepEqual(await check(checker, room.code, guestSession.token), { type: 'available', available: false, reason: 'finished' });
    const late = await connect();
    late.send({ type: 'resume', code: room.code, token: guestSession.token });
    assert.match((await late.receive(m => m.type === 'resume-unavailable')).message, /^This game is over and its results are no longer available/);
    late.send({ type: 'join', code: room.code });
    assert.equal((await late.receive(m => m.type === 'error')).reason, 'ended');
    // After finishedMs the room is gone, also while its host stays online.
    const second = await team('Cleaned up');
    second.host.send({ type: 'finished' });
    assert.equal((await check(checker, second.room.code, second.guestSession.token)).available, true);
    await new Promise(r => setTimeout(r, 650));
    assert.deepEqual(await check(checker, second.room.code, second.guestSession.token), { type: 'available', available: false });
    checker.send({ type: 'join', code: second.room.code });
    assert.equal((await checker.receive(m => m.type === 'error')).reason, 'ended');

    // End game for everyone from a saved host game: resume with the host's token, then leave.
    const third = await team('Ended from a save');
    third.host.socket.close(); await once(third.host.socket, 'close');
    const ender = await connect();
    ender.send({ type: 'resume', code: third.room.code, token: third.hostSession.token });
    await ender.receive(m => m.type === 'session');
    ender.send({ type: 'leave' });
    assert.match((await third.guest.receive(m => m.type === 'closed')).message, /host ended/);
    assert.equal((await check(checker, third.room.code, third.guestSession.token)).available, false);
    assert.equal((await check(checker, third.room.code, third.hostSession.token)).available, false);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});
