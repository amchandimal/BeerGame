import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame, Role } from './game';
import { MultiplayerSession, Room } from './multiplayer';
import { demandScenario, rankScores, ScoreRow } from './challenge';
import { InformationVisibility, visibleHistory, visibleRoles } from './visibility';
import { debrief } from './debrief';

// A started Classroom Group Challenge on a host-only teacher's browser, with an open channel to every member. Groups: [id, name, [member, role][]].
async function groupsHost(visibility: InformationVisibility, groups: [string, string, [string, Role][]][]) {
  const host = new MultiplayerSession(() => {});
  host.id = 'host';
  const members = [{ id: 'host', role: null, nickname: 'Teacher', group: null }, ...groups.flatMap(([group, , seats]) => seats.map(([id, role]) => ({ id, role, nickname: id.toUpperCase(), group })))];
  const room: Room = { name: 'Groups', code: '246810', host: 'host', kind: 'groups', hostPlays: false, challenge: { seed: 11, method: 'wma' }, visibility, started: true, humanRoles: [], members,
    groups: groups.map(([id, name, seats]) => ({ id, name, humanRoles: seats.map(s => s[1]), automated: {}, waiting: {}, takeBack: [], absentAtStart: [] })) };
  const sent: Record<string, any[]> = {};
  for (const m of members.slice(1)) { sent[m.id] = []; (host as any).peers.set(m.id, { channel: { readyState: 'open', send: (raw: string) => sent[m.id].push(JSON.parse(raw)) } }); }
  await (host as any).handleSignaling({ type: 'room', room });
  const games: Map<string, BeerGame> = (host as any).challengeGames;
  const groupOf = (id: string) => members.find(m => m.id === id)!.group!;
  const order = (id: string, amount: number) => (host as any).receive(id, { type: 'order', week: games.get(groupOf(id))!.week, amount });
  const states = (id: string) => sent[id].filter(m => m.type === 'state');
  // A guest's own model, built from the snapshots the host sent it.
  const guest = (id: string) => { const g = new MultiplayerSession(() => {}); g.id = id; g.room = JSON.parse(JSON.stringify(host.room)); for (const s of states(id)) (g as any).applySnapshot(s); return g; };
  return { host, sent, states, order, games, guest };
}
const red: [string, string, [string, Role][]] = ['g1', 'Red', [['a', 'Retailer'], ['b', 'Wholesaler']]], blue: [string, string, [string, Role][]] = ['g2', 'Blue', [['c', 'Retailer'], ['d', 'Distributor']]];

test('Groups: each group advances once its own members have ordered, every group gets the same seeded customer demand, and rows rank by total chain cost', async () => {
  const { host, order, games, states } = await groupsHost('network', [red, blue]);
  assert.deepEqual([...games.keys()], ['g1', 'g2']);
  assert.deepEqual(host.leaderboard.map(r => [r.id, r.nickname, r.members]), [['g2', 'Blue', [{ nickname: 'C', role: 'Retailer' }, { nickname: 'D', role: 'Distributor' }]], ['g1', 'Red', [{ nickname: 'A', role: 'Retailer' }, { nickname: 'B', role: 'Wholesaler' }]]]);
  order('a', 6);
  assert.deepEqual([games.get('g1')!.week, games.get('g2')!.week], [1, 1], 'Red waits for B');
  assert.deepEqual(states('b').at(-1).submittedRoles, ['Retailer']); assert.deepEqual(states('c').at(-1).submittedRoles, [], 'Blue never sees Red’s submissions');
  order('c', 9); order('d', 9);
  assert.deepEqual([games.get('g1')!.week, games.get('g2')!.week], [1, 2], 'Blue advances on its own');
  order('b', 6);
  assert.equal(games.get('g1')!.week, 2);
  for (let week = 2; week <= 24; week++) { order('a', week % 5 + 4); order('b', 7); order('c', 12); order('d', 3); }
  const [g1, g2] = [games.get('g1')!, games.get('g2')!], scenario = demandScenario({ seed: 11, method: 'wma' });
  assert.ok(g1.complete && g2.complete);
  assert.deepEqual(g1.history.map(r => r.demand), scenario); assert.deepEqual(g2.history.map(r => r.demand), scenario);
  assert.notEqual(g1.totalCost, g2.totalCost);
  // System-played roles keep the usual policy: Red's Distributor and Manufacturer, Blue's Wholesaler and Manufacturer.
  assert.notDeepEqual(g1.history.map(r => r.parties[2].order), g2.history.map(r => r.parties[2].order));
  for (const row of host.leaderboard) { const game = games.get(row.id)!; assert.equal(row.cost, game.totalCost); assert.equal(row.completedWeeks, 24); assert.ok(row.finished && row.elapsedMs! >= 0); }
  assert.deepEqual(host.leaderboard.map(r => r.id), g1.totalCost < g2.totalCost ? ['g1', 'g2'] : ['g2', 'g1']);
  assert.equal(host.revealed, true);
});

test('Groups: total chain cost ranks first and time from the shared start breaks ties; unfinished groups follow by progress', () => {
  const row = (name: string, cost: number, elapsedMs: number | null, completedWeeks = 24): ScoreRow => ({ id: name, nickname: name, members: [{ nickname: name + ' 1', role: 'Retailer' }], cost, elapsedMs, finished: completedWeeks === 24, connected: true, completedWeeks });
  assert.deepEqual(rankScores([row('Blue', 912.5, 40000), row('Red', 840, 90000), row('Green', 840, 60000), row('Gold', 100, null, 20), row('Teal', 90, null, 22)]).map(r => r.nickname), ['Green', 'Red', 'Blue', 'Teal', 'Gold']);
});

test('Groups: hidden data stays hidden until every group is over; each member then receives only their own group’s full chain and debrief', async () => {
  for (const visibility of ['none', 'dyadic', 'network'] as const) {
    const { host, order, games, states, guest } = await groupsHost(visibility, [red, blue]);
    for (let week = 1; week <= 24; week++) { order('a', 5); order('b', 8); }
    for (let week = 1; week <= 23; week++) { order('c', 9); order('d', 4); }
    assert.equal(host.revealed, false, 'Red finished, Blue has not');
    for (const [id, role] of [['a', 'Retailer'], ['b', 'Wholesaler']] as const) {
      const last = states(id).at(-1);
      assert.equal(last.revealed, undefined);
      assert.deepEqual(last.parties.map((p: any) => p.role), visibleRoles(visibility, role));
      assert.equal(!!last.customer, visibleRoles(visibility, role).includes('Retailer'), 'customer demand only while the Retailer is in view');
      assert.equal(guest(id).over, true); assert.equal(guest(id).revealed, false);
    }
    order('c', 9); order('d', 4);
    assert.equal(host.revealed, true);
    for (const [id, own, other] of [['a', 'g1', 'g2'], ['b', 'g1', 'g2'], ['c', 'g2', 'g1'], ['d', 'g2', 'g1']]) {
      const final = states(id).at(-1), role = host.room!.members.find(m => m.id === id)!.role!;
      assert.equal(final.revealed, true);
      assert.deepEqual(final.history, visibleHistory(games.get(own)!, 'network', role));
      assert.notDeepEqual(final.history, visibleHistory(games.get(other)!, 'network', role));
      const player = guest(id);
      assert.equal(player.revealed, true);
      assert.deepEqual(debrief(player.game!), debrief(games.get(own)!));
      assert.equal(player.game!.totalCost, host.leaderboard.find(r => r.id === own)!.cost);
    }
  }
});

test('Groups: Finish classroom stops unfinished groups as incomplete, refuses later orders and reveals each group its own chain', async () => {
  const { host, order, games, states } = await groupsHost('none', [red, blue]);
  for (let week = 1; week <= 24; week++) { order('c', 8); order('d', 8); }
  for (let week = 1; week <= 5; week++) { order('a', 4); order('b', 4); }
  assert.deepEqual(host.classroomCounts, { playing: 1, disconnected: 0, finished: 1, incomplete: 0 });
  host.finishClassroom();
  assert.equal(host.revealed, true);
  assert.deepEqual(host.leaderboard.map(r => [r.nickname, r.finished, !!r.incomplete, r.completedWeeks]), [['Blue', true, false, 24], ['Red', false, true, 5]]);
  order('a', 4); order('b', 4);
  assert.equal(games.get('g1')!.week, 6, 'orders after Finish classroom are refused');
  assert.deepEqual(states('a').at(-1).parties, games.get('g1')!.parties);
  assert.equal(states('a').at(-1).revealed, true);
});

test('Groups: a member who leaves is decided on within their group; a group the system plays entirely plays on to the end; guests see only their own group', async () => {
  const { host, order, games, guest } = await groupsHost('network', [red, blue]);
  order('c', 5); order('d', 5);
  // B leaves Red: only Red waits, the teacher sees the prompt with the group's name, and Blue keeps playing.
  const away = JSON.parse(JSON.stringify(host.room));
  away.members.find((m: any) => m.id === 'b').online = false; away.members.find((m: any) => m.id === 'b').left = true;
  (host as any).peers.delete('b');
  await (host as any).handleSignaling({ type: 'room', room: away });
  assert.deepEqual(host.absences.map(a => [a.group, a.role, a.state, a.canDecide, a.message]), [['g1', 'Wholesaler', 'left', true, 'Red: B (Wholesaler) has left. Let the system play Wholesaler, or keep waiting?']]);
  assert.deepEqual(host.classroomCounts, { playing: 1, disconnected: 1, finished: 0, incomplete: 0 });
  order('a', 6);
  assert.equal(games.get('g1')!.week, 1);
  order('c', 5); order('d', 5);
  assert.equal(games.get('g2')!.week, 3);
  const player = guest('a');
  assert.deepEqual(player.chain!.members.map(m => m.id), ['a', 'b']); assert.equal(player.scoreId, 'g1');
  assert.deepEqual(player.activeRoles, ['Retailer', 'Wholesaler']); assert.deepEqual(player.systemRoles, ['Distributor', 'Manufacturer']);
  // The server records the teacher's decision on Red only; the waiting week completes with A's order.
  const decided = JSON.parse(JSON.stringify(away));
  decided.groups[0].automated = { Wholesaler: 'Teacher' };
  await (host as any).handleSignaling({ type: 'room', room: decided });
  assert.equal(games.get('g1')!.week, 2);
  assert.deepEqual(host.absences.map(a => [a.group, a.state, a.message]), [['g1', 'system', 'Red: B (Wholesaler) left. The system is playing Wholesaler (decided by Teacher).']]);
  // A leaves too and the system plays every seat of Red: Red plays on to week 24 at once; Blue is unaffected.
  const empty = JSON.parse(JSON.stringify(decided));
  empty.members.find((m: any) => m.id === 'a').online = false; empty.members.find((m: any) => m.id === 'a').left = true;
  empty.groups[0].automated.Retailer = 'Teacher';
  (host as any).peers.delete('a');
  await (host as any).handleSignaling({ type: 'room', room: empty });
  assert.equal(games.get('g1')!.complete, true); assert.equal(games.get('g2')!.week, 3);
  assert.equal(host.leaderboard.find(r => r.id === 'g1')!.finished, true); assert.equal(host.revealed, false);
});

test('Groups: the host checkpoint keeps every group engine and pending order, and after a refresh each group continues where it was', async () => {
  const store = new Map<string, string>();
  (globalThis as any).localStorage = { get length() { return store.size; }, key: (i: number) => [...store.keys()][i] ?? null, getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v), removeItem: (k: string) => void store.delete(k) };
  try {
    const { host, order, games, sent } = await groupsHost('dyadic', [red, blue]);
    order('a', 6); order('c', 7); order('d', 7);
    (host as any).token = 'secret'; (host as any).persist();
    const saved = JSON.parse([...store.values()][0]);
    assert.deepEqual(saved.challengeGames.map(([id, game]: [string, BeerGame]) => [id, game.week]), [['g1', 1], ['g2', 2]]);
    assert.deepEqual(saved.groupPending, [['g1', { Retailer: 6 }], ['g2', {}]]);
    const next = new MultiplayerSession(() => {});
    next.id = 'host'; (next as any).restoring = saved;
    for (const id of Object.keys(sent)) (next as any).peers.set(id, { channel: { readyState: 'open', send: (raw: string) => sent[id].push(JSON.parse(raw)) } });
    await (next as any).handleSignaling({ type: 'room', room: saved.room });
    const restored: Map<string, BeerGame> = (next as any).challengeGames;
    assert.equal(next.isObserver, true); assert.equal(next.game, null);
    assert.deepEqual(restored.get('g2')!.parties, games.get('g2')!.parties); assert.deepEqual(restored.get('g1')!.customer, demandScenario({ seed: 11, method: 'wma' }));
    (next as any).receive('a', { type: 'order', week: 1, amount: 2 }); // A late copy is answered with the recorded amount.
    assert.deepEqual(sent.a.filter(m => m.type === 'ack').at(-1), { type: 'ack', week: 1, accepted: true, amount: 6 });
    (next as any).receive('b', { type: 'order', week: 1, amount: 5 });
    assert.equal(restored.get('g1')!.week, 2); assert.equal(restored.get('g1')!.history[0].parties[0].order, 6);
    assert.equal(restored.get('g2')!.week, 2);
    assert.deepEqual(next.leaderboard.map(r => [r.nickname, r.completedWeeks]), [['Blue', 1], ['Red', 1]]);
  } finally { delete (globalThis as any).localStorage; }
});
