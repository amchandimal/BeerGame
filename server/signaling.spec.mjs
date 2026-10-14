import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { createSignalingServer, joinCode } from './index.mjs';

test('room credentials, atomic role locking, signaling isolation and room lifecycle', async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = [];
  async function client() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`);
    sockets.push(socket);
    const messages = []; const waiters = [];
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      const index = waiters.findIndex(w => w.predicate(message));
      if (index >= 0) { const waiter = waiters.splice(index, 1)[0]; clearTimeout(waiter.timer); waiter.resolve(message); }
      else messages.push(message);
    });
    const receive = predicate => {
      const index = messages.findIndex(predicate);
      if (index >= 0) return Promise.resolve(messages.splice(index, 1)[0]);
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, timer: setTimeout(() => reject(new Error('Timed out waiting for signaling message')), 3000) };
        waiters.push(waiter);
      });
    };
    const welcome = await receive(m => m.type === 'welcome');
    return { socket, id: welcome.id, receive, send: data => { if (data.type === 'claim') socket.send(JSON.stringify({ type: 'nickname', nickname: welcome.id.slice(0, 12) })); socket.send(JSON.stringify(data)); } };
  }
  try {
    const host = await client();
    host.send({ type: 'create', name: 'Invalid setting', visibility: 'secret' });
    assert.match((await host.receive(m => m.type === 'error')).message, /information visibility/);
    host.send({ type: 'create', name: 'Test Chain' });
    const { room } = await host.receive(m => m.type === 'room');
    assert.match(room.code, /^\d{6}$/);
    assert.equal(room.visibility, 'network');
    host.send({ type: 'started' });
    assert.match((await host.receive(m => m.type === 'error')).message, /select a role/);
    host.send({ type: 'claim', role: 'Retailer' });
    await host.receive(m => m.type === 'room' && m.room.members[0].role === 'Retailer');
    const guest = await client();
    guest.send({ type: 'join', code: 'not-a-code' });
    const badCode = await guest.receive(m => m.type === 'error');
    assert.match(badCode.message, /six-digit code/); assert.equal(badCode.request, 'join'); assert.equal(badCode.reason, 'invalid'); // Errors name their request, so clients show them beside the field.
    guest.send({ type: 'join', name: 'test chain', code: room.code });
    await guest.receive(m => m.type === 'room');
    guest.send({ type: 'nickname', nickname: host.id.slice(0, 12).toUpperCase() });
    assert.deepEqual(await guest.receive(m => m.type === 'error'), { type: 'error', message: 'That nickname is taken.', request: 'nickname' });
    guest.send({ type: 'claim', role: 'Retailer' });
    const taken = await guest.receive(m => m.type === 'error');
    assert.match(taken.message, /already been taken/); assert.equal(taken.request, 'claim');
    host.send({ type: 'started' });
    assert.match((await host.receive(m => m.type === 'error')).message, /every joined player/);
    guest.send({ type: 'claim', role: 'Wholesaler' });
    await guest.receive(m => m.type === 'room' && m.room.members.some(p => p.role === 'Wholesaler'));
    const outsider = await client();
    outsider.send({ type: 'signal', to: host.id, signal: { description: 'forged' } });
    assert.match((await outsider.receive(m => m.type === 'error')).message, /not in this supply chain/);
    guest.send({ type: 'signal', to: host.id, signal: { candidate: { candidate: 'test' } } });
    assert.equal((await host.receive(m => m.type === 'signal')).from, guest.id);
    for (const role of ['Distributor', 'Manufacturer']) {
      const peer = await client();
      peer.send({ type: 'join', name: room.name, code: room.code }); await peer.receive(m => m.type === 'room');
      peer.send({ type: 'claim', role }); await peer.receive(m => m.type === 'room' && m.room.members.some(p => p.role === role));
    }
    host.send({ type: 'started' });
    assert.equal((await host.receive(m => m.type === 'room' && m.room.started)).room.members.length, 4);
    outsider.send({ type: 'join', name: room.name, code: room.code });
    assert.match((await outsider.receive(m => m.type === 'error')).message, /already started/);
    const config = await fetch(`http://127.0.0.1:${server.address().port}/rtc-config`).then(r => r.json());
    assert.ok(Array.isArray(config.iceServers));
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /app-root/);
    host.send({ type: 'leave' });
    assert.match((await guest.receive(m => m.type === 'closed')).message, /host ended/);
  } finally {
    for (const socket of sockets) socket.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve));
  }
});

test('creator starts with one, two or three roles and freezes the human roster', async () => {
  for (const count of [1, 2, 3]) {
    const { server, wss } = createSignalingServer();
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const sockets = [];
    const roles = ['Retailer', 'Wholesaler', 'Distributor'];
    async function client() {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`);
      sockets.push(socket);
      const inbox = [];
      socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
      const receive = async predicate => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const index = inbox.findIndex(predicate);
          if (index >= 0) return inbox.splice(index, 1)[0];
          await new Promise(resolve => setTimeout(resolve, 5));
        }
        throw new Error('Timed out waiting for room state');
      };
      const welcome = await receive(m => m.type === 'welcome');
      return { socket, receive, send: message => { if (message.type === 'claim') socket.send(JSON.stringify({ type: 'nickname', nickname: welcome.id.slice(0, 12) })); socket.send(JSON.stringify(message)); } };
    }
    try {
      const host = await client();
      const visibility = ['network', 'dyadic', 'none'][count - 1];
      host.send({ type: 'create', name: 'Mixed Chain', visibility });
      const { room } = await host.receive(m => m.type === 'room');
      host.send({ type: 'claim', role: roles[0] });
      await host.receive(m => m.type === 'room' && m.room.members[0].role === roles[0]);
      for (let i = 1; i < count; i++) {
        const guest = await client();
        guest.send({ type: 'join', name: room.name, code: room.code, visibility: 'network' });
        assert.equal((await guest.receive(m => m.type === 'room')).room.visibility, visibility);
        guest.send({ type: 'claim', role: roles[i] });
        await guest.receive(m => m.type === 'room' && m.room.members.some(p => p.role === roles[i]));
      }
      host.send({ type: 'started' });
      const started = await host.receive(m => m.type === 'room' && m.room.started);
      assert.equal(started.room.members.length, count);
      assert.equal(started.room.visibility, visibility);
      assert.deepEqual(started.room.humanRoles, roles.slice(0, count));
      host.send({ type: 'started' });
      assert.match((await host.receive(m => m.type === 'error')).message, /already started/);
      const outsider = await client();
      outsider.send({ type: 'join', name: room.name, code: room.code });
      assert.match((await outsider.receive(m => m.type === 'error')).message, /already started/);
      if (count > 1) {
        sockets[1].send(JSON.stringify({ type: 'leave' }));
        const left = await host.receive(m => m.type === 'room' && m.room.started && m.room.members.some(p => p.left));
        assert.equal(left.room.members.length, count); // A guest leaving a started Team game keeps the seat.
        assert.deepEqual(left.room.humanRoles, roles.slice(0, count));
      }
    } finally {
      for (const socket of sockets) socket.terminate();
      wss.close(); await new Promise(resolve => server.close(resolve));
    }
  }
});

test('a started Team guest who leaves keeps the seat; the creator, or any member while the creator is offline, lets the system play; a returning player waits for the host handback', async () => {
  const { server, wss } = createSignalingServer({ awayMs: 100 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`);
    const inbox = [];
    socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
    const receive = async predicate => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Timed out waiting for signaling message');
    };
    await receive(m => m.type === 'welcome');
    return { socket, receive, send: message => socket.send(JSON.stringify(message)) };
  }
  const seat = (message, role) => message.room.members.find(m => m.role === role);
  try {
    let host = await connect(), alex = await connect();
    const sam = await connect(), tokens = {};
    host.send({ type: 'create', name: 'Seats' });
    const { room } = await host.receive(m => m.type === 'room');
    for (const [player, nickname, role] of [[host, 'Host', 'Retailer'], [alex, 'Alex', 'Wholesaler'], [sam, 'Sam', 'Distributor']]) {
      if (player !== host) player.send({ type: 'join', code: room.code });
      tokens[nickname] = (await player.receive(m => m.type === 'session')).token;
      player.send({ type: 'nickname', nickname }); player.send({ type: 'claim', role });
      await player.receive(m => m.type === 'room' && seat(m, role));
    }
    const rejoin = async nickname => { const player = await connect(); player.send({ type: 'resume', code: room.code, token: tokens[nickname] }); await player.receive(m => m.type === 'session'); return player; };
    host.send({ type: 'started' }); await host.receive(m => m.type === 'room' && m.room.started);
    host.send({ type: 'decide', role: 'Wholesaler', system: true });
    assert.match((await host.receive(m => m.type === 'error')).message, /Alex has not left/);
    alex.send({ type: 'leave' }); await once(alex.socket, 'close');
    const left = await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.left);
    assert.equal(left.room.members.length, 3); assert.equal(seat(left, 'Wholesaler').online, false);
    sam.send({ type: 'decide', role: 'Wholesaler', system: true });
    assert.match((await sam.receive(m => m.type === 'error')).message, /Only the host/);
    host.send({ type: 'decide', role: 'Wholesaler', system: false });
    assert.equal((await sam.receive(m => m.type === 'room' && m.room.waiting.Wholesaler)).room.waiting.Wholesaler, 'Host');
    host.send({ type: 'decide', role: 'Wholesaler', system: false });
    assert.match((await host.receive(m => m.type === 'error')).message, /Host already chose to keep waiting/);
    // Returning clears the prompt; a plain disconnect becomes a departure only after the grace period.
    alex = await rejoin('Alex');
    const back = await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.connection === 2);
    assert.equal(seat(back, 'Wholesaler').left, false); assert.deepEqual(back.room.waiting, {});
    alex.socket.close(); await once(alex.socket, 'close');
    await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.online === false && !seat(m, 'Wholesaler').left);
    host.send({ type: 'decide', role: 'Wholesaler', system: true });
    assert.match((await host.receive(m => m.type === 'error')).message, /has not left/);
    await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.left && seat(m, 'Wholesaler').connection === 2);
    // With the creator offline, the first other member's answer is recorded for everyone.
    host.socket.close(); await once(host.socket, 'close');
    await sam.receive(m => m.type === 'room' && seat(m, 'Retailer').online === false);
    sam.send({ type: 'decide', role: 'Wholesaler', system: true });
    assert.equal((await sam.receive(m => m.type === 'room' && m.room.automated.Wholesaler)).room.automated.Wholesaler, 'Sam');
    sam.send({ type: 'decide', role: 'Wholesaler', system: false });
    assert.match((await sam.receive(m => m.type === 'error')).message, /Sam already let the system play Wholesaler/);
    // A returning player is queued for take-back until the host hands the role back; leaving again cancels it.
    alex = await rejoin('Alex');
    assert.deepEqual((await sam.receive(m => m.type === 'room' && m.room.takeBack.length)).room.takeBack, ['Wholesaler']);
    sam.send({ type: 'handback', role: 'Wholesaler' });
    alex.socket.close(); await once(alex.socket, 'close');
    const gone = await sam.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.online === false && seat(m, 'Wholesaler').connection === 3);
    assert.deepEqual(gone.room.takeBack, []); assert.equal(gone.room.automated.Wholesaler, 'Sam');
    alex = await rejoin('Alex');
    await sam.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.connection === 4 && m.room.takeBack.includes('Wholesaler'));
    host = await rejoin('Host');
    host.send({ type: 'handback', role: 'Wholesaler' });
    const handed = await sam.receive(m => m.type === 'room' && seat(m, 'Retailer').connection === 2 && !m.room.automated.Wholesaler);
    assert.deepEqual(handed.room.takeBack, []);
    host.send({ type: 'leave' });
    assert.match((await alex.receive(m => m.type === 'closed')).message, /host ended/);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});

test('before start a player changes role atomically; the host removes a disconnected member or starts without them; codes are normalised and join failures give a reason', async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const site = `127.0.0.1:${server.address().port}`;
  async function connect() {
    const socket = new WebSocket(`ws://${site}/signaling`);
    const inbox = [];
    socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
    const receive = async predicate => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Timed out waiting for signaling message');
    };
    await receive(m => m.type === 'welcome');
    const player = { socket, receive, send: message => socket.send(JSON.stringify(message)) };
    player.enter = async message => { player.send(message); Object.assign(player, await receive(m => m.type === 'session')); return player; };
    return player;
  }
  const seat = (message, role) => message.room.members.find(m => m.role === role);
  const refused = async (player, code) => { player.send({ type: 'join', code }); const error = await player.receive(m => m.type === 'error'); return [error.reason, error.message]; };
  try {
    // Whitespace, dashes and dots are ignored and leading zeros kept; an invitation link counts only for this site.
    for (const typed of ['012345', '012 345', ' 012-345 ', '012.345', '01 23 45', '012–345', `http://${site}/multiplayer/join/012345`, `https://${site}/multiplayer/join/012345/?from=qr`]) assert.equal(joinCode(typed, site), '012345', typed);
    for (const bad of ['12345', '1234567', '12a456', '', null, 'http://elsewhere.example/multiplayer/join/012345', `http://${site}/multiplayer/join/12345`, `http://${site}/multiplayer/012345`]) assert.equal(joinCode(bad, site), null, String(bad));

    const host = await (await connect()).enter({ type: 'create', name: 'Lobby' });
    const { room } = await host.receive(m => m.type === 'room');
    host.send({ type: 'nickname', nickname: 'Host' }); host.send({ type: 'claim', role: 'Retailer' });
    await host.receive(m => m.type === 'room' && seat(m, 'Retailer'));
    // Joining by a spaced code and by the invitation link.
    let alex = await (await connect()).enter({ type: 'join', code: `${room.code.slice(0, 3)} ${room.code.slice(3)}` });
    const sam = await (await connect()).enter({ type: 'join', code: `http://${site}/multiplayer/join/${room.code}` });
    for (const [player, nickname, role] of [[alex, 'Alex', 'Wholesaler'], [sam, 'Sam', 'Distributor']]) { player.send({ type: 'nickname', nickname }); player.send({ type: 'claim', role }); }
    await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.nickname === 'Alex' && seat(m, 'Distributor')?.nickname === 'Sam');

    // A held role is refused; a free one is switched to, freeing the old one. Two players racing for one role: exactly one gets it.
    alex.send({ type: 'claim', role: 'Distributor' });
    assert.deepEqual(await alex.receive(m => m.type === 'error'), { type: 'error', message: 'That role has already been taken.', request: 'claim' });
    alex.send({ type: 'claim', role: 'Manufacturer' });
    const switched = await host.receive(m => m.type === 'room' && seat(m, 'Manufacturer'));
    assert.equal(seat(switched, 'Manufacturer').nickname, 'Alex'); assert.equal(seat(switched, 'Wholesaler'), undefined);
    alex.send({ type: 'claim', role: 'Wholesaler' });
    await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.nickname === 'Alex' && !seat(m, 'Manufacturer'));
    alex.send({ type: 'claim', role: 'Manufacturer' }); sam.send({ type: 'claim', role: 'Manufacturer' });
    const raced = await host.receive(m => m.type === 'room' && seat(m, 'Manufacturer'));
    const [winner, loser] = seat(raced, 'Manufacturer').nickname === 'Alex' ? [alex, sam] : [sam, alex];
    assert.match((await loser.receive(m => m.type === 'error' && m.request === 'claim')).message, /already been taken/);
    winner.send({ type: 'claim', role: winner === alex ? 'Wholesaler' : 'Distributor' });
    await host.receive(m => m.type === 'room' && !seat(m, 'Manufacturer') && seat(m, 'Wholesaler')?.nickname === 'Alex' && seat(m, 'Distributor')?.nickname === 'Sam');

    // A full lobby, then removal: only the host, only a disconnected member, and the removed player is told on return.
    const kim = await (await connect()).enter({ type: 'join', code: room.code });
    const outsider = await connect();
    const [fullReason, fullMessage] = await refused(outsider, room.code);
    assert.equal(fullReason, 'full'); assert.match(fullMessage, /full \(4 of 4 players\).*remove an inactive player/);
    host.send({ type: 'remove', id: sam.id });
    assert.equal((await host.receive(m => m.type === 'error')).message, 'Sam is connected again.');
    kim.socket.close(); await once(kim.socket, 'close');
    await host.receive(m => m.type === 'room' && m.room.members.some(p => p.id === kim.id && p.online === false));
    alex.send({ type: 'remove', id: kim.id });
    assert.match((await alex.receive(m => m.type === 'error')).message, /Only the host can remove/);
    host.send({ type: 'remove', id: kim.id });
    assert.equal((await host.receive(m => m.type === 'room' && m.room.members.length === 3)).room.members.some(p => p.id === kim.id), false);
    const returning = await connect();
    returning.send({ type: 'check', code: room.code, token: kim.token });
    assert.deepEqual(await returning.receive(m => m.type === 'available'), { type: 'available', available: false, reason: 'removed' });
    returning.send({ type: 'resume', code: room.code, token: kim.token });
    assert.match((await returning.receive(m => m.type === 'resume-unavailable')).message, /host removed you from this game before it started/);

    // Start without a disconnected member: an online member cannot be left out, a failed start changes nothing, and Alex keeps the seat, played by the system.
    alex.socket.close(); await once(alex.socket, 'close');
    await host.receive(m => m.type === 'room' && seat(m, 'Wholesaler')?.online === false);
    host.send({ type: 'started' });
    assert.match((await host.receive(m => m.type === 'error')).message, /reconnect/);
    host.send({ type: 'started', without: [sam.id, alex.id] });
    assert.equal((await host.receive(m => m.type === 'error')).message, 'Only disconnected players can be left out.');
    host.send({ type: 'started', without: [alex.id] });
    const started = await host.receive(m => m.type === 'room' && m.room.started);
    assert.deepEqual(started.room.humanRoles, ['Retailer', 'Wholesaler', 'Distributor']);
    assert.deepEqual(started.room.automated, { Wholesaler: 'Host' }); assert.deepEqual(started.room.absentAtStart, ['Wholesaler']); // Offline at the start, not left.
    assert.equal(seat(started, 'Wholesaler').left, true); assert.equal(started.room.members.length, 3);
    const [startedReason, startedMessage] = await refused(outsider, room.code);
    assert.equal(startedReason, 'started'); assert.match(startedMessage, /already started.*resume from the browser they joined with/);
    alex = await (await connect()).enter({ type: 'resume', code: room.code, token: alex.token });
    const back = (await host.receive(m => m.type === 'room' && m.room.started && seat(m, 'Wholesaler')?.online)).room;
    assert.deepEqual(back.takeBack, ['Wholesaler']); assert.deepEqual(back.absentAtStart, []);

    // Classroom: a disconnected student left out at start is removed and told so on return.
    const teacher = await (await connect()).enter({ type: 'create', name: 'Class', kind: 'classroom', challenge: { role: 'Retailer', seed: 3, method: 'wma' } });
    const classroom = (await teacher.receive(m => m.type === 'room')).room;
    teacher.send({ type: 'nickname', nickname: 'Teacher' });
    const student = await (await connect()).enter({ type: 'join', code: classroom.code });
    student.send({ type: 'nickname', nickname: 'Student' });
    await teacher.receive(m => m.type === 'room' && m.room.members.some(p => p.nickname === 'Student'));
    student.socket.close(); await once(student.socket, 'close');
    await teacher.receive(m => m.type === 'room' && m.room.members.some(p => p.online === false));
    teacher.send({ type: 'started', without: [student.id] });
    const begun = await teacher.receive(m => m.type === 'room' && m.room.started);
    assert.equal(begun.room.members.length, 1); assert.deepEqual(begun.room.humanRoles, ['Retailer']);
    returning.send({ type: 'check', code: classroom.code, token: student.token });
    assert.equal((await returning.receive(m => m.type === 'available')).reason, 'started-without');
    returning.send({ type: 'resume', code: classroom.code, token: student.token });
    assert.match((await returning.receive(m => m.type === 'resume-unavailable')).message, /started this game without you/);

    // An ended game and an unknown code are told apart; malformed input is refused before any lookup.
    host.send({ type: 'leave' });
    await alex.receive(m => m.type === 'closed');
    assert.deepEqual(await refused(outsider, room.code), ['ended', `Game ${room.code} has ended. Ask the host for a new code.`]);
    let unused = 0; while ([room.code, classroom.code].includes(String(unused).padStart(6, '0'))) unused++;
    const code = String(unused).padStart(6, '0');
    assert.deepEqual(await refused(outsider, code), ['unknown', `No game uses code ${code}. Check the code with your host.`]);
    for (const bad of ['12 34 5', `http://elsewhere.example/multiplayer/join/${classroom.code}`]) assert.deepEqual(await refused(outsider, bad), ['invalid', 'Enter the six-digit code or paste the invitation link.']);
  } finally {
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve)); await new Promise(resolve => server.close(resolve));
  }
});

test('Classroom Group Challenge: players create, join and switch groups with unique names and at most four members; roles are unique within a group, also when two members race; empty groups are dropped at start; each group keeps its own seat decisions', async () => {
  const { server, wss } = createSignalingServer({ awayMs: 50 });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const sockets = [];
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`);
    sockets.push(socket);
    const inbox = [], client = { socket, room: null, send: message => socket.send(JSON.stringify(message)) };
    socket.on('message', raw => { const message = JSON.parse(raw.toString()); if (message.type === 'room') client.room = message.room; inbox.push(message); });
    client.receive = async predicate => {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(index, 1)[0];
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      throw new Error('Timed out waiting for signaling message');
    };
    client.error = async request => (await client.receive(m => m.type === 'error' && m.request === request)).message;
    client.id = (await client.receive(m => m.type === 'welcome')).id;
    return client;
  }
  const member = (room, id) => room.members.find(m => m.id === id);
  const named = (room, name) => room.groups.find(g => g.name === name);
  try {
    const host = await connect();
    host.send({ type: 'create', name: 'Groups', kind: 'groups', hostPlays: true, challenge: { seed: 5, method: 'sma' } });
    assert.equal(await host.error('create'), 'In a Classroom Group Challenge the host hosts only.');
    host.send({ type: 'create', name: 'Groups', kind: 'groups', challenge: { method: 'sma' } });
    assert.match(await host.error('create'), /demand method and seed/);
    host.send({ type: 'create', name: 'Groups', kind: 'groups', visibility: 'dyadic', challenge: { role: 'Retailer', seed: 5, method: 'wma' } });
    const { room } = await host.receive(m => m.type === 'room');
    assert.deepEqual([room.kind, room.hostPlays, room.challenge, room.groups, member(room, host.id).role, member(room, host.id).group], ['groups', false, { method: 'wma', seed: 5 }, [], null, null]);
    host.send({ type: 'nickname', nickname: 'Teacher' });
    host.send({ type: 'group-create', name: 'Staff' });
    assert.match(await host.error('group-create'), /only in a Classroom Group Challenge lobby/);

    const players = {};
    for (const nickname of ['Ada', 'Ben', 'Cy', 'Dee', 'Eve', 'Fay', 'Gus', 'Hal']) {
      const player = players[nickname] = await connect();
      player.send({ type: 'join', code: room.code });
      player.token = (await player.receive(m => m.type === 'session')).token;
      if (nickname === 'Ada') { player.send({ type: 'group-create', name: 'Red' }); assert.equal(await player.error('group-create'), 'Enter a nickname before joining a group.'); }
      player.send({ type: 'nickname', nickname });
      await player.receive(m => m.type === 'room' && member(m.room, player.id)?.nickname === nickname);
    }
    const { Ada, Ben, Cy, Dee, Eve, Fay, Gus, Hal } = players;
    Ada.send({ type: 'claim', role: 'Retailer' });
    assert.equal(await Ada.error('claim'), 'Join a group before choosing a role.');
    for (const name of ['', 'x'.repeat(25)]) { Ada.send({ type: 'group-create', name }); assert.equal(await Ada.error('group-create'), 'Group name must be 1–24 characters.'); }
    Ada.send({ type: 'group-create', name: ' Red ' });
    const red = (await Ada.receive(m => m.type === 'room' && m.room.groups.length === 1)).room.groups[0];
    assert.deepEqual([red.name, member(Ada.room, Ada.id).group], ['Red', red.id]);
    Ben.send({ type: 'group-create', name: 'RED' });
    assert.equal(await Ben.error('group-create'), 'That group name is taken.');
    for (const player of [Ben, Cy]) { player.send({ type: 'group-join', group: red.id }); await player.receive(m => m.type === 'room' && member(m.room, player.id)?.group === red.id); }
    Ada.send({ type: 'claim', role: 'Retailer' });
    await Ada.receive(m => m.type === 'room' && member(m.room, Ada.id)?.role === 'Retailer');
    Ben.send({ type: 'claim', role: 'Retailer' });
    assert.equal(await Ben.error('claim'), 'That role has already been taken.');

    // Two members of Red claim Wholesaler at once: exactly one holds it.
    Ben.send({ type: 'claim', role: 'Wholesaler' }); Cy.send({ type: 'claim', role: 'Wholesaler' });
    const lost = await Promise.any([Ben, Cy].map(player => player.receive(m => m.type === 'error' && m.request === 'claim').then(e => [player, e.message])));
    assert.equal(lost[1], 'That role has already been taken.');
    const [wholesaler, loser] = lost[0] === Ben ? [Cy, Ben] : [Ben, Cy];
    await host.receive(m => m.type === 'room' && member(m.room, wholesaler.id)?.role === 'Wholesaler');
    assert.deepEqual(host.room.members.filter(m => m.group === red.id && m.role === 'Wholesaler').map(m => m.id), [wholesaler.id]);
    assert.equal(member(host.room, loser.id).role, null);

    // Dee and Eve both join Red, which has three members: one is refused, so Red never has five.
    Dee.send({ type: 'group-join', group: red.id }); Eve.send({ type: 'group-join', group: red.id });
    const full = await Promise.any([Dee, Eve].map(player => player.receive(m => m.type === 'error' && m.request === 'group-join').then(e => [player, e.message])));
    assert.equal(full[1], 'Red is full (4 of 4 players). Join another group or create one.');
    const [fourth, outside] = full[0] === Dee ? [Eve, Dee] : [Dee, Eve];
    await host.receive(m => m.type === 'room' && member(m.room, fourth.id)?.group === red.id);
    assert.equal(host.room.members.filter(m => m.group === red.id).length, 4);

    // Roles are unique per group, not per room.
    outside.send({ type: 'group-create', name: 'Blue' });
    const blue = (await outside.receive(m => m.type === 'room' && m.room.groups.length === 2)).room.groups[1];
    outside.send({ type: 'claim', role: 'Retailer' });
    await host.receive(m => m.type === 'room' && member(m.room, outside.id)?.role === 'Retailer');
    // Switching groups frees the old role at once.
    wholesaler.send({ type: 'group-join', group: blue.id });
    const switched = await host.receive(m => m.type === 'room' && member(m.room, wholesaler.id)?.group === blue.id);
    assert.equal(member(switched.room, wholesaler.id).role, null);
    loser.send({ type: 'claim', role: 'Wholesaler' });
    await host.receive(m => m.type === 'room' && member(m.room, loser.id)?.role === 'Wholesaler');
    Gus.send({ type: 'group-join', group: red.id });
    await host.receive(m => m.type === 'room' && member(m.room, Gus.id)?.group === red.id);
    wholesaler.send({ type: 'group-join', group: red.id });
    assert.match(await wholesaler.error('group-join'), /Red is full/);
    Gus.send({ type: 'group-join', group: blue.id }); // Back out of Red again.
    await host.receive(m => m.type === 'room' && member(m.room, Gus.id)?.group === blue.id);
    // Fay creates Green, then moves to Blue: Green stays listed, empty, until the start drops it.
    Fay.send({ type: 'group-create', name: 'Green' });
    const green = (await Fay.receive(m => m.type === 'room' && m.room.groups.length === 3)).room.groups[2];
    Fay.send({ type: 'group-join', group: blue.id });
    await host.receive(m => m.type === 'room' && member(m.room, Fay.id)?.group === blue.id && m.room.groups.length === 3);
    Hal.send({ type: 'group-create', name: 'Gold' });
    const gold = (await Hal.receive(m => m.type === 'room' && m.room.groups.length === 4)).room.groups[3];
    Hal.send({ type: 'claim', role: 'Retailer' });
    await host.receive(m => m.type === 'room' && member(m.room, Hal.id)?.role === 'Retailer');

    // Start blockers: a player outside every group, then players without a role.
    const late = await connect();
    late.send({ type: 'join', code: room.code }); late.send({ type: 'nickname', nickname: 'Ivy' });
    await host.receive(m => m.type === 'room' && m.room.members.some(p => p.nickname === 'Ivy'));
    host.send({ type: 'started' });
    assert.equal(await host.error('started'), 'Every player must join a group before starting.');
    late.send({ type: 'leave' });
    await host.receive(m => m.type === 'room' && !m.room.members.some(p => p.nickname === 'Ivy'));
    host.send({ type: 'started' });
    assert.match(await host.error('started'), /every joined player must select a role/);
    for (const [player, role] of [[fourth, 'Distributor'], [wholesaler, 'Wholesaler'], [Fay, 'Distributor'], [Gus, 'Manufacturer']]) { player.send({ type: 'claim', role }); await host.receive(m => m.type === 'room' && member(m.room, player.id)?.role === role); }
    // Hal (alone in Gold) and Fay (in Blue) disconnect; the host starts without them.
    for (const player of [Hal, Fay]) { player.socket.close(); await host.receive(m => m.type === 'room' && member(m.room, player.id)?.online === false); }
    host.send({ type: 'started' });
    assert.equal(await host.error('started'), 'Wait for every player to reconnect.');
    host.send({ type: 'started', without: [Hal.id, Fay.id] });
    const started = (await host.receive(m => m.type === 'room' && m.room.started)).room;
    assert.deepEqual(started.groups.map(g => [g.name, [...g.humanRoles].sort(), g.automated, g.absentAtStart]), [['Red', ['Distributor', 'Retailer', 'Wholesaler'], {}, []], ['Blue', ['Distributor', 'Manufacturer', 'Retailer', 'Wholesaler'], { Distributor: 'Teacher' }, ['Distributor']]], 'Green (empty) and Gold (Hal removed) are dropped');
    assert.ok(!started.groups.some(g => g.id === green.id || g.id === gold.id));
    assert.equal(member(started, Hal.id), undefined); assert.equal(member(started, Fay.id).left, true);
    assert.deepEqual(started.humanRoles, []);
    const hal = await connect();
    hal.send({ type: 'resume', code: room.code, token: Hal.token });
    assert.equal((await hal.receive(m => m.type === 'resume-unavailable')).message, 'The host started this game without you. You can join another game.');

    // After the start, groups are fixed; a seat decision belongs to one group.
    Cy.send({ type: 'group-join', group: blue.id });
    assert.match(await Cy.error('group-join'), /before it starts/);
    loser.send({ type: 'leave' }); // Red's Wholesaler leaves and keeps the seat.
    await host.receive(m => m.type === 'room' && member(m.room, loser.id)?.left);
    host.send({ type: 'decide', role: 'Wholesaler', system: true });
    assert.equal(await host.error('decide'), 'There is no decision to make for that role.', 'the host names the group');
    host.send({ type: 'decide', role: 'Wholesaler', system: true, group: blue.id });
    assert.match(await host.error('decide'), /has not left the game/);
    host.send({ type: 'decide', role: 'Wholesaler', system: true, group: red.id });
    const decided = (await host.receive(m => m.type === 'room' && named(m.room, 'Red')?.automated?.Wholesaler)).room;
    assert.deepEqual([named(decided, 'Red').automated, named(decided, 'Blue').automated], [{ Wholesaler: 'Teacher' }, { Distributor: 'Teacher' }]);
    // Fay returns to Blue: her seat is handed back only by the host, for Blue.
    const fay = await connect();
    fay.send({ type: 'resume', code: room.code, token: Fay.token });
    await fay.receive(m => m.type === 'session');
    const back = (await host.receive(m => m.type === 'room' && named(m.room, 'Blue')?.takeBack?.length)).room;
    assert.deepEqual([named(back, 'Blue').takeBack, named(back, 'Blue').absentAtStart, named(back, 'Red').takeBack], [['Distributor'], [], []]);
    host.send({ type: 'handback', role: 'Distributor', group: red.id });
    host.send({ type: 'handback', role: 'Distributor', group: blue.id });
    const handed = (await host.receive(m => m.type === 'room' && m.room.started && !named(m.room, 'Blue').automated.Distributor)).room;
    assert.deepEqual([named(handed, 'Blue').takeBack, named(handed, 'Red').automated], [[], { Wholesaler: 'Teacher' }]);
  } finally {
    for (const socket of sockets) socket.terminate();
    wss.close(); await new Promise(resolve => server.close(resolve));
  }
});
