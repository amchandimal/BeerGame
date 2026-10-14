import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame, ROLES } from './game';
import { visibleRoles, visibleHistory, visibleCsv, dataScope, InformationVisibility } from './visibility';
import { MultiplayerSession } from './multiplayer';
import { demandScenario } from './challenge';

test('visibility includes own role and only immediate neighbors for dyadic', () => {
  assert.deepEqual(visibleRoles('dyadic', 'Retailer'), ['Retailer', 'Wholesaler']);
  assert.deepEqual(visibleRoles('dyadic', 'Wholesaler'), ['Retailer', 'Wholesaler', 'Distributor']);
  assert.deepEqual(visibleRoles('dyadic', 'Distributor'), ['Wholesaler', 'Distributor', 'Manufacturer']);
  assert.deepEqual(visibleRoles('dyadic', 'Manufacturer'), ['Distributor', 'Manufacturer']);
  for (const role of ROLES) {
    assert.deepEqual(visibleRoles('none', role), [role]);
    assert.deepEqual(visibleRoles('network', role), [...ROLES]);
  }
});

test('history and CSV respect visibility without changing the engine or default export', () => {
  const game = new BeerGame('Manufacturer');
  game.advance(10);
  const before = JSON.stringify(game);
  assert.equal(visibleCsv(game, 'network', 'Manufacturer'), game.csv());
  assert.deepEqual(visibleHistory(game, 'none', 'Manufacturer')[0].parties.map(p => p.role), ['Manufacturer']);
  assert.equal(visibleHistory(game, 'none', 'Manufacturer')[0].demand, null);
  const csv = visibleCsv(game, 'none', 'Manufacturer').split('\n');
  assert.equal(csv.length, 2);
  assert.ok(csv[1].startsWith('1,,Manufacturer,'));
  assert.equal(JSON.stringify(game), before);
});

test('WebRTC broadcasts only permitted data to each guest, with public submission status', () => {
  for (const visibility of ['network', 'dyadic', 'none'] as InformationVisibility[]) {
    const host = new MultiplayerSession(() => {});
    host.id = 'host';
    host.room = { name: 'Scoped chain', code: 'ABCDEF123456', host: 'host', visibility, started: true,
      humanRoles: [...ROLES], members: ROLES.map(role => ({ id: role === 'Retailer' ? 'host' : role, role })) };
    host.game = new BeerGame('Retailer'); host.game.advance(9);
    host.pending = { Retailer: 11, Wholesaler: 22, Distributor: 33, Manufacturer: 44 };
    const messages: any[] = [];
    for (const role of ROLES.slice(1)) (host as any).peers.set(role, { channel: { readyState: 'open', send: (raw: string) => messages.push({ role, snapshot: JSON.parse(raw) }) } });
    (host as any).broadcast();
    assert.equal(messages.length, 3);
    for (const { role, snapshot } of messages) {
      const expected = visibleRoles(visibility, role);
      assert.deepEqual(snapshot.parties.map((p: any) => p.role), expected);
      assert.deepEqual(snapshot.history[0].parties.map((p: any) => p.role), expected);
      assert.deepEqual(Object.keys(snapshot.pending), expected);
      assert.deepEqual(snapshot.submittedRoles, [...ROLES]);
      assert.equal(snapshot.history[0].demand, expected.includes('Retailer') ? 4 : null);
      const guest = new MultiplayerSession(() => {});
      guest.id = role; guest.room = host.room;
      (guest as any).applySnapshot(snapshot);
      assert.equal(guest.game!.current.role, role);
      assert.equal(guest.game!.current.inventory, host.game.parties.find(p => p.role === role)!.inventory);
      assert.equal(guest.hasSubmitted('Retailer'), true);
      for (const hidden of ROLES.filter(r => !expected.includes(r))) assert.deepEqual(guest.game!.parties.find(p => p.role === hidden)!.shipments, []);
    }
    assert.equal(host.game.parties.length, 4);
  }
});

const LEVELS: InformationVisibility[] = ['network', 'dyadic', 'none'];
// Open mock channels from the creator to the given guest ids; collects the snapshots each guest receives.
function withChannels(host: MultiplayerSession, ids: string[]) {
  const sent: Record<string, any[]> = Object.fromEntries(ids.map(id => [id, []]));
  for (const id of ids) (host as any).peers.set(id, { channel: { readyState: 'open', send: (raw: string) => { const msg = JSON.parse(raw); if (msg.type === 'state') sent[id].push(msg); } } });
  return sent;
}

test('Team: nothing is revealed before week 24; the creator then sends an unfiltered snapshot and guests replace their placeholders', () => {
  for (const visibility of LEVELS) {
    const host = new MultiplayerSession(() => {});
    host.id = 'host';
    host.room = { name: 'Reveal', code: '123456', host: 'host', kind: 'team', challenge: null, visibility, started: true, humanRoles: [...ROLES], members: ROLES.map(role => ({ id: role === 'Retailer' ? 'host' : role, role, nickname: role })) };
    host.game = new BeerGame('Retailer');
    for (let week = 1; week <= 23; week++) host.game.advance(week % 5 + 4);
    const sent = withChannels(host, ROLES.slice(1));
    (host as any).broadcast();
    assert.equal(host.revealed, false);
    const guests = new Map(ROLES.slice(1).map(role => { const guest = new MultiplayerSession(() => {}); guest.id = role; guest.room = { ...host.room! }; return [role, guest]; }));
    for (const [role, guest] of guests) {
      const before = sent[role].at(-1), allowed = visibleRoles(visibility, role);
      assert.equal(before.revealed, undefined);
      assert.deepEqual(before.parties.map((p: any) => p.role), allowed);
      (guest as any).applySnapshot(before);
      assert.equal(guest.revealed, false); assert.equal(guest.over, false);
      assert.equal(visibleCsv(guest.game!, dataScope(visibility, guest.revealed), role).split('\n').length, 1 + allowed.length * 23);
      for (const hidden of ROLES.filter(r => !allowed.includes(r))) assert.deepEqual(guest.game!.parties.find(p => p.role === hidden)!.shipments, []);
    }
    host.game.advance(8);
    (host as any).broadcast();
    assert.equal(host.revealed, true);
    for (const [role, guest] of guests) {
      const after = sent[role].at(-1);
      assert.equal(after.revealed, true);
      assert.deepEqual(after.parties.map((p: any) => p.role), [...ROLES]);
      assert.ok(after.history.every((row: any) => row.demand !== null && row.parties.length === 4));
      (guest as any).applySnapshot(after);
      assert.equal(guest.revealed, true); assert.equal(guest.over, true);
      assert.deepEqual(guest.game!.parties, host.game.parties);
      assert.deepEqual(guest.game!.history, host.game.history);
      assert.equal(guest.game!.totalCost, host.game.totalCost);
      assert.equal(visibleCsv(guest.game!, dataScope(visibility, guest.revealed), role), host.game.csv());
    }
  }
});

test('players keep their final screen when the room closes; players still playing return to setup', async () => {
  const room = () => ({ name: 'Closing', code: '123456', host: 'host', kind: 'team' as const, challenge: null, visibility: 'none' as const, started: true, humanRoles: ['Retailer', 'Wholesaler'] as any, members: [{ id: 'host', role: 'Retailer' as const, nickname: 'Host' }, { id: 'g', role: 'Wholesaler' as const, nickname: 'Guest' }] });
  const closed = { type: 'closed', message: 'The host ended the supply chain or its reconnect window expired.' };
  const playing = new MultiplayerSession(() => {});
  playing.id = 'g'; playing.room = room(); playing.game = new BeerGame('Wholesaler');
  await (playing as any).handleSignaling(closed);
  assert.equal(playing.room, null); assert.equal(playing.game, null); assert.match(playing.error, /host ended/);
  const finished = new MultiplayerSession(() => {});
  finished.id = 'g'; finished.room = room(); finished.game = new BeerGame('Wholesaler');
  for (let week = 1; week <= 24; week++) finished.game.advance(4);
  await (finished as any).handleSignaling(closed);
  assert.ok(finished.room); assert.equal(finished.game!.complete, true);
  assert.equal(finished.error, ''); assert.match(finished.closedNotice, /host ended/); assert.equal(finished.status, 'Supply chain closed');
});

// A host-only classroom with two Wholesaler competitors, a and b, whose engines share the seeded scenario.
function classroom(visibility: InformationVisibility) {
  const host = new MultiplayerSession(() => {});
  host.id = 'host';
  const challenge = { role: 'Wholesaler' as const, seed: 7, method: 'cyclic' as const };
  host.room = { name: 'Class', code: '654321', host: 'host', kind: 'classroom', hostPlays: false, challenge, visibility, started: true, humanRoles: ['Wholesaler', 'Wholesaler'], members: [{ id: 'host', role: null, nickname: 'Teacher' }, { id: 'a', role: 'Wholesaler', nickname: 'A' }, { id: 'b', role: 'Wholesaler', nickname: 'B' }] };
  const games: Map<string, BeerGame> = (host as any).challengeGames;
  for (const id of ['a', 'b']) games.set(id, new BeerGame('Wholesaler', demandScenario(challenge)));
  host.leaderboard = ['a', 'b'].map(id => ({ id, nickname: id.toUpperCase(), completedWeeks: 0, cost: 0, elapsedMs: null, finished: false, connected: true, incomplete: false }));
  const sent = withChannels(host, ['a', 'b']);
  const play = (id: string, weeks: number, amount: (week: number) => number) => { for (let i = 0; i < weeks; i++) { const week = games.get(id)!.week; (host as any).acceptOrder(id, week, amount(week)); } };
  return { host, games, sent, play };
}

test('Classroom: nothing is revealed while a competitor is still playing; each competitor then gets only their own full run', () => {
  for (const visibility of LEVELS) {
    const { host, games, sent, play } = classroom(visibility);
    play('a', 24, week => week % 7 + 3);
    play('b', 23, () => 8);
    assert.equal(host.revealed, false);
    for (const id of ['a', 'b']) {
      assert.equal(sent[id].at(-1).revealed, undefined);
      assert.deepEqual(sent[id].at(-1).parties.map((p: any) => p.role), visibleRoles(visibility, 'Wholesaler'));
    }
    play('b', 1, () => 8);
    assert.equal(host.revealed, true); assert.equal(host.classroomOver, true);
    for (const [id, other] of [['a', 'b'], ['b', 'a']]) {
      const final = sent[id].at(-1);
      assert.equal(final.revealed, true);
      assert.deepEqual(final.history, visibleHistory(games.get(id)!, 'network', 'Wholesaler'));
      assert.notDeepEqual(final.history, visibleHistory(games.get(other)!, 'network', 'Wholesaler'));
      const guest = new MultiplayerSession(() => {});
      guest.id = id; guest.room = { ...host.room! };
      (guest as any).applySnapshot(final);
      assert.equal(guest.revealed, true); assert.equal(guest.over, true);
      assert.equal(visibleCsv(guest.game!, dataScope(visibility, guest.revealed), 'Wholesaler'), games.get(id)!.csv());
    }
  }
});

test('Finish classroom stops unfinished runs, marks them incomplete and reveals each competitor their own run', () => {
  const { host, games, sent, play } = classroom('none');
  play('a', 24, () => 6);
  play('b', 5, () => 9);
  assert.equal(host.revealed, false);
  host.finishClassroom();
  assert.equal(host.revealed, true);
  assert.deepEqual(host.leaderboard.map(r => [r.id, r.finished, !!r.incomplete, r.completedWeeks]).sort(), [['a', true, false, 24], ['b', false, true, 5]]);
  const stopped = sent['b'].at(-1);
  assert.equal(stopped.revealed, true); assert.equal(stopped.week, 6);
  assert.deepEqual(stopped.parties, games.get('b')!.parties);
  assert.equal(sent['a'].at(-1).revealed, true);
  (host as any).acceptOrder('b', 6, 9);
  assert.equal(games.get('b')!.week, 6, 'orders after Finish classroom are refused');
  const guest = new MultiplayerSession(() => {});
  guest.id = 'b'; guest.room = { ...host.room! };
  (guest as any).applySnapshot(stopped);
  assert.equal(guest.revealed, true); assert.equal(guest.over, true); assert.equal(guest.game!.complete, false);
});
