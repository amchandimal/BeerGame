import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame, Role } from './game';
import { ACK_MS, MultiplayerSession, Room } from './multiplayer';
import { demandScenario } from './challenge';

// A host and guests joined by in-memory channels. Messages queue until delivered, so a test can lose, hold or reorder them.
function network(room: Room) {
  const host = new MultiplayerSession(() => {});
  host.id = room.host; host.room = room;
  const toHost: [string, any][] = [], toGuest: Record<string, any[]> = {}, guests: Record<string, MultiplayerSession> = {}, links: Record<string, { readyState: string }> = {};
  (host as any).socket = { readyState: 1, send() {}, close() {} };
  for (const member of room.members.filter(m => m.id !== room.host)) {
    const guest = guests[member.id] = new MultiplayerSession(() => {});
    guest.id = member.id; guest.room = { ...room };
    (guest as any).socket = { readyState: 1, send() {}, close() {} };
    toGuest[member.id] = [];
    const link = links[member.id] = { readyState: 'open', send: (raw: string) => toHost.push([member.id, JSON.parse(raw)]) };
    (guest as any).peers.set(room.host, { channel: link });
    (host as any).peers.set(member.id, { channel: { readyState: 'open', send: (raw: string) => toGuest[member.id].push(JSON.parse(raw)) } });
  }
  const late = (guest: MultiplayerSession) => { (guest as any).sent.at -= ACK_MS; }; // As if the reply were overdue.
  const net = { host, guests, toHost, toGuest, links, late,
    toHostOnly: () => { for (const [from, msg] of toHost.splice(0)) (net.host as any).receive(from, msg); },
    deliver: (id?: string) => { if (!id) net.toHostOnly(); for (const guest of id ? [id] : Object.keys(guests)) for (const msg of toGuest[guest].splice(0)) (guests[guest] as any).receive(room.host, msg); } };
  return net;
}
// A host restored from its saved checkpoint after a refresh, with its channels to the guests reopened.
async function refreshed(host: MultiplayerSession, toGuest: Record<string, any[]>) {
  const h = host as any, saved = JSON.parse(JSON.stringify({ version: 1, token: 'saved', id: host.id, room: host.room, savedAt: Date.now(), game: host.game, pending: host.pending, challengeGames: [...h.challengeGames], leaderboard: host.leaderboard, challengeStarted: h.challengeStarted }));
  const next = new MultiplayerSession(() => {});
  next.id = host.id; (next as any).restoring = saved;
  await (next as any).handleSignaling({ type: 'room', room: { ...saved.room, members: saved.room.members.map((m: any) => ({ ...m, online: m.id === host.id })) } });
  next.room = saved.room;
  for (const id of Object.keys(toGuest)) (next as any).peers.set(id, { channel: { readyState: 'open', send: (raw: string) => toGuest[id].push(JSON.parse(raw)) } });
  return next;
}
const acks = (messages: any[]) => messages.filter(m => m.type === 'ack');

test('Team: the host acknowledges each order, re-sends are answered with the recorded amount, and no week advances twice', async () => {
  const room: Room = { name: 'Acks', code: '123456', host: 'host', kind: 'team', challenge: null, visibility: 'none', started: true, humanRoles: ['Retailer', 'Wholesaler', 'Distributor'],
    members: [{ id: 'host', role: 'Retailer', nickname: 'Host' }, { id: 'alex', role: 'Wholesaler', nickname: 'Alex' }, { id: 'sam', role: 'Distributor', nickname: 'Sam' }] };
  const net = network(room), { guests: { alex, sam }, toHost, toGuest, links, deliver, late } = net;
  net.host.game = new BeerGame('Retailer');
  (net.host as any).broadcast(); deliver();
  assert.equal(alex.game!.week, 1); assert.equal(alex.orderStatus, null);

  net.host.submit(5);
  assert.deepEqual(net.host.orderStatus, { week: 1, amount: 5, state: 'accepted', waitingFor: ['Alex', 'Sam'], message: 'Accepted for week 1: 5 cases. Waiting for Alex and Sam.', canRetry: false });

  // Alex's order is lost on the way: Sending, then no reply, then Send again delivers it once.
  alex.submit(7);
  assert.equal(alex.orderStatus!.state, 'sending'); assert.equal(alex.submitted, true);
  assert.equal(alex.hasSubmitted('Wholesaler'), false, 'not shown as submitted before the host has it');
  toHost.length = 0;
  late(alex);
  assert.deepEqual(alex.orderStatus, { week: 1, amount: 7, state: 'unconfirmed', waitingFor: [], message: 'No reply from the host yet. Send your week 1 order (7 cases) again.', canRetry: true });
  alex.resend(); deliver();
  assert.deepEqual(acks(toGuest.alex), []);
  assert.deepEqual(alex.orderStatus, { week: 1, amount: 7, state: 'accepted', waitingFor: ['Sam'], message: 'Accepted for week 1: 7 cases. Waiting for Sam.', canRetry: false });
  assert.deepEqual(net.host.pending, { Retailer: 5, Wholesaler: 7 });

  // A duplicate, even with another amount, keeps the first order; only Alex hears back, and nothing is broadcast.
  (net.host as any).receive('alex', { type: 'order', week: 1, amount: 9 });
  assert.deepEqual(toGuest.alex, [{ type: 'ack', week: 1, accepted: true, amount: 7 }]);
  assert.deepEqual(toGuest.sam, []);
  assert.deepEqual(net.host.pending, { Retailer: 5, Wholesaler: 7 });
  deliver();

  // The host refreshes with Alex's order pending: a re-send after the refresh is still answered, not counted again.
  net.host = await refreshed(net.host, toGuest);
  assert.deepEqual(net.host.pending, { Retailer: 5, Wholesaler: 7 });
  (net.host as any).receive('alex', { type: 'order', week: 1, amount: 7 });
  assert.deepEqual(toGuest.alex, [{ type: 'ack', week: 1, accepted: true, amount: 7 }]);
  deliver('alex');

  // Sam's reply is delayed: Sam sends again while the first copy has already completed the week. The week advances once.
  sam.submit(6); net.toHostOnly();
  assert.equal(net.host.game!.week, 2);
  assert.equal(sam.orderStatus!.state, 'sending');
  late(sam);
  assert.equal(sam.orderStatus!.canRetry, true);
  sam.resend(); net.toHostOnly();
  assert.equal(net.host.game!.week, 2); assert.equal(net.host.game!.history.length, 1);
  assert.deepEqual(net.host.game!.history[0].parties.map(p => p.order).slice(0, 3), [5, 7, 6]);
  assert.deepEqual(acks(toGuest.sam), [{ type: 'ack', week: 1, accepted: true, amount: 6 }, { type: 'ack', week: 1, accepted: true, amount: 6 }]);
  // Under None visibility, snapshots never carry another role's amount; acks go only to the player who sent the order.
  for (const id of ['alex', 'sam']) for (const msg of toGuest[id]) if (msg.type === 'state') assert.deepEqual(Object.keys(msg.pending).filter(r => r !== (id === 'alex' ? 'Wholesaler' : 'Distributor')), []);
  assert.deepEqual(acks(toGuest.alex), []);
  deliver();
  assert.equal(sam.game!.week, 2); assert.equal(sam.orderStatus, null); assert.equal(sam.submitted, false);

  // Connection interrupted before the reply: the order is not lost, and goes again once the channel reopens.
  alex.submit(8); toHost.length = 0;
  links.alex.readyState = 'closed';
  assert.deepEqual(alex.orderStatus, { week: 2, amount: 8, state: 'interrupted', waitingFor: [], message: 'Connection interrupted. Your week 2 order (8 cases) is not confirmed yet.', canRetry: false });
  alex.resend(); assert.equal(toHost.length, 0, 'nothing is sent while interrupted');
  links.alex.readyState = 'open'; late(alex);
  alex.resend(); deliver();
  assert.equal(alex.orderStatus!.state, 'accepted'); assert.equal(net.host.pending.Wholesaler, 8);

  // A refused order unlocks the field and explains why.
  net.host.room!.automated = { Distributor: 'Host' };
  sam.submit(3); deliver();
  assert.equal(sam.submitted, false); assert.equal(sam.errorField, 'order'); assert.equal(sam.error, 'The system is playing Distributor this week.');
});

test('Classroom: one order per run per week, after retries and a host refresh; the old stuck state now times out', async () => {
  const challenge = { role: 'Wholesaler' as Role, seed: 7, method: 'cyclic' as const };
  const room: Room = { name: 'Class', code: '654321', host: 'host', kind: 'classroom', hostPlays: false, challenge, visibility: 'network', started: true, humanRoles: ['Wholesaler', 'Wholesaler'],
    members: [{ id: 'host', role: null, nickname: 'Teacher' }, { id: 'a', role: 'Wholesaler', nickname: 'A' }, { id: 'b', role: 'Wholesaler', nickname: 'B' }] };
  const net = network(room), { guests: { a, b }, toGuest, deliver, late } = net;
  const games = (session: MultiplayerSession): Map<string, BeerGame> => (session as any).challengeGames;
  for (const id of ['a', 'b']) games(net.host).set(id, new BeerGame('Wholesaler', demandScenario(challenge)));
  net.host.leaderboard = ['a', 'b'].map(id => ({ id, nickname: id.toUpperCase(), completedWeeks: 0, cost: 0, elapsedMs: null, finished: false, connected: true, incomplete: false }));
  (net.host as any).broadcast(); deliver();

  a.submit(8);
  assert.equal(a.orderStatus!.state, 'sending');
  late(a);
  assert.equal(a.orderStatus!.state, 'unconfirmed', 'a missing reply no longer leaves the order locked forever');
  a.resend(); net.toHostOnly();
  assert.equal(games(net.host).get('a')!.week, 2, 'the second copy does not play week 2');
  assert.deepEqual(acks(toGuest.a), [{ type: 'ack', week: 1, accepted: true, amount: 8 }, { type: 'ack', week: 1, accepted: true, amount: 8 }]);
  assert.deepEqual(acks(toGuest.b), []);
  deliver();
  assert.equal(a.game!.week, 2); assert.equal(a.submitted, false); assert.equal(a.orderStatus, null);
  assert.equal(net.host.leaderboard.find(r => r.id === 'a')!.completedWeeks, 1);

  // After a host refresh, a late copy of week 1 is answered from the restored run, and week 2 plays once.
  net.host = await refreshed(net.host, toGuest);
  for (const [week, amount] of [[1, 3], [2, 9], [2, 9]]) (net.host as any).receive('a', { type: 'order', week, amount });
  assert.equal(games(net.host).get('a')!.week, 3); assert.equal(games(net.host).get('a')!.history[0].parties[1].order, 8);
  assert.deepEqual(acks(toGuest.a).slice(-3).map(m => [m.week, m.amount]), [[1, 8], [2, 9], [2, 9]]);
  assert.equal(net.host.leaderboard.find(r => r.id === 'a')!.completedWeeks, 2);
  assert.deepEqual(net.host.classroomCounts, { playing: 2, disconnected: 0, finished: 0, incomplete: 0 });

  // Orders after Finish classroom are refused with the reason; a stopped run is over, so it shows no order status.
  b.submit(4);
  net.host.finishClassroom(); deliver();
  assert.equal(b.over, true); assert.equal(b.orderStatus, null);
  assert.deepEqual(net.host.classroomCounts, { playing: 0, disconnected: 0, finished: 0, incomplete: 2 });
});
