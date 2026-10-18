import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame } from './game';
import { demandScenario, singleGame } from './challenge';
import { MAX_SAVES, SINGLE_KEY, SavedSession, changesSaves, readSaves, readSingle, removeSave, saveKey, tabHadSingle, writeSave, writeSingle } from './saves';

// In-memory Storage; `quota` (characters) makes setItem fail as a full browser storage would.
class MemoryStorage implements Storage {
  private data = new Map<string, string>();
  constructor(private quota = Infinity) {}
  get length() { return this.data.size; }
  key(i: number) { return [...this.data.keys()][i] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) {
    const used = [...this.data].reduce((n, [k, v]) => n + (k === key ? 0 : k.length + v.length), 0);
    if (used + key.length + value.length > this.quota) throw new DOMException('Storage is full.', 'QuotaExceededError');
    this.data.set(key, String(value));
  }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
  keys() { return [...this.data.keys()].sort(); }
}
const save = (code: string, id: string, savedAt: number, extra: Partial<SavedSession> = {}): SavedSession => ({ version: 1, token: `token-${code}-${id}`, id, savedAt, game: null, pending: {}, challengeGames: [], leaderboard: [], challengeStarted: 0,
  room: { kind: 'team', challenge: null, name: `Game ${code}`, code, visibility: 'network', host: id, started: false, humanRoles: [], members: [] }, ...extra });

test('the single v1 slot moves to its own key once; invalid or duplicate old saves are dropped', () => {
  const storage = new MemoryStorage(), old = save('123456', 'a', 1000);
  storage.setItem('beer-game.multiplayer.v1', JSON.stringify(old));
  assert.deepEqual(readSaves(storage), [old]);
  assert.deepEqual(storage.keys(), ['beer-game.multiplayer.v2.123456.a']);
  assert.deepEqual(readSaves(storage), [old], 'reading again changes nothing');
  // A newer copy of the same membership under the new key wins over the old slot.
  const newer = { ...old, savedAt: 2000 };
  storage.setItem(saveKey(newer), JSON.stringify(newer));
  storage.setItem('beer-game.multiplayer.v1', JSON.stringify(old));
  assert.deepEqual(readSaves(storage), [newer]);
  assert.equal(storage.getItem('beer-game.multiplayer.v1'), null);
  for (const bad of ['not json', JSON.stringify({ version: 1, token: 't', id: 'x', room: { code: '12' }, savedAt: 1 }), 'null']) {
    storage.setItem('beer-game.multiplayer.v1', bad);
    assert.deepEqual(readSaves(storage), [newer]);
    assert.equal(storage.getItem('beer-game.multiplayer.v1'), null);
  }
  // An old save that cannot be copied (storage full) stays for the next read.
  const full = new MemoryStorage(50);
  (full as any).data.set('beer-game.multiplayer.v1', JSON.stringify(old));
  assert.deepEqual(readSaves(full), []);
  assert.ok(full.getItem('beer-game.multiplayer.v1'));
});

test(`at most ${MAX_SAVES} multiplayer saves are kept, one per room and member, newest first; a new one replaces the least recently saved`, () => {
  const storage = new MemoryStorage();
  for (let i = 1; i <= MAX_SAVES; i++) writeSave(save(`10000${i}`, 'm', i * 100), storage);
  assert.deepEqual(readSaves(storage).map(s => s.room.code), ['100005', '100004', '100003', '100002', '100001']);
  writeSave(save('100001', 'm', 900), storage); // Rewriting an existing save never removes another.
  writeSave(save('100002', 'other-member', 50), storage); // Same room, other member: its own save, replacing the oldest (100002 · m at 200).
  assert.equal(readSaves(storage).length, MAX_SAVES);
  assert.deepEqual(readSaves(storage).map(saveKey).sort(), ['100001.m', '100002.other-member', '100003.m', '100004.m', '100005.m'].map(k => 'beer-game.multiplayer.v2.' + k));
  writeSave(save('200000', 'n', 1000), storage);
  assert.deepEqual(readSaves(storage).map(s => s.room.code + '.' + s.id), ['200000.n', '100001.m', '100005.m', '100004.m', '100003.m']);
  // A save another tab has open is spared while others remain; when all are open, the least recently saved still goes.
  const tabs = new MemoryStorage(), codes = () => readSaves(tabs).map(s => s.room.code).sort();
  for (let i = 1; i <= MAX_SAVES; i++) writeSave(save(`50000${i}`, 'm', i), tabs);
  writeSave(save('600000', 'n', 10), tabs, key => /50000[12]/.test(key));
  assert.deepEqual(codes(), ['500001', '500002', '500004', '500005', '600000']);
  writeSave(save('700000', 'o', 11), tabs, () => true);
  assert.deepEqual(codes(), ['500002', '500004', '500005', '600000', '700000']);
  removeSave(save('100004', 'm', 0), storage);
  assert.equal(readSaves(storage).length, MAX_SAVES - 1);
  // Entries that are not valid saves, or sit under another save's key, are removed when read; other keys are untouched.
  storage.setItem('beer-game.multiplayer.v2.300000.x', '{');
  storage.setItem('beer-game.multiplayer.v2.300001.y', JSON.stringify(save('300002', 'y', 1)));
  storage.setItem('beer-game.single.v1', 'kept');
  assert.equal(readSaves(storage).length, MAX_SAVES - 1);
  assert.equal(storage.keys().filter(k => k.startsWith('beer-game.multiplayer.v2.')).length, MAX_SAVES - 1);
  assert.equal(storage.getItem('beer-game.single.v1'), 'kept');
  // A full storage refuses the write, which the caller reports; storage that is unavailable reads as no saves.
  assert.throws(() => writeSave(save('400000', 'z', 1, { leaderboard: Array(50).fill({ nickname: 'x'.repeat(100) }) }), new MemoryStorage(1000)), /full/);
  assert.deepEqual(readSaves(undefined as unknown as Storage), []);
});

test('an unfinished single-player game is saved with its visibility; a finished or invalid one is removed; the tab marker follows it', () => {
  const storage = new MemoryStorage(), tab = new MemoryStorage(), game = new BeerGame('Wholesaler');
  for (const order of [5, 9, 3]) game.advance(order);
  assert.equal(writeSingle(game, 'dyadic', null, storage, tab), true);
  const restored = readSingle(storage)!;
  assert.equal(restored.visibility, 'dyadic');
  assert.ok(restored.game instanceof BeerGame);
  assert.deepEqual([restored.game.player, restored.game.week, restored.game.history, restored.game.parties], [game.player, 4, game.history, game.parties]);
  restored.game.advance(4); game.advance(4);
  assert.deepEqual(restored.game.parties, game.parties, 'the restored engine plays on identically');
  assert.equal(tabHadSingle(tab), true);
  while (!game.complete) game.advance(4);
  writeSingle(game, 'dyadic', null, storage, tab);
  assert.equal(storage.getItem(SINGLE_KEY), null); assert.equal(tabHadSingle(tab), false);
  writeSingle(new BeerGame('Retailer'), 'none', null, storage, tab);
  writeSingle(null, 'none', null, storage, tab);
  assert.equal(readSingle(storage), null); assert.equal(tabHadSingle(tab), false);
  for (const bad of ['{', JSON.stringify({ version: 1, visibility: 'everything', game: new BeerGame('Retailer') }), JSON.stringify({ version: 1, visibility: 'none', game: { ...new BeerGame('Retailer'), week: 3 } })]) {
    storage.setItem(SINGLE_KEY, bad);
    assert.equal(readSingle(storage), null);
    assert.equal(storage.getItem(SINGLE_KEY), null);
  }
  assert.equal(writeSingle(new BeerGame('Retailer'), 'none', null, new MemoryStorage(10), tab), false);
});

test('a Single Player save keeps the customer series with its method and seed, so a restored game plays on with identical demand; older saves keep the classic demand', () => {
  const storage = new MemoryStorage(), tab = new MemoryStorage(), demand = { method: 'cyclic' as const, seed: 3141592653 }, game = singleGame('Manufacturer', demand);
  for (const order of [6, 2]) game.advance(order);
  writeSingle(game, 'none', demand, storage, tab);
  const restored = readSingle(storage)!;
  assert.deepEqual(restored.demand, demand);
  assert.deepEqual(restored.game.customer, demandScenario(demand));
  assert.equal(restored.game.scenario, undefined);
  while (!game.complete) { game.advance(5); restored.game.advance(5); }
  assert.deepEqual(restored.game.history, game.history, 'the same demand, orders and costs to week 24');
  // A save written before random demand has neither field and restores with 4 → 8.
  const old = new BeerGame('Retailer');
  for (const order of [4, 4]) old.advance(order);
  storage.setItem(SINGLE_KEY, JSON.stringify({ version: 1, visibility: 'network', game: old, savedAt: 1 }));
  const classic = readSingle(storage)!;
  assert.equal(classic.demand, undefined); assert.equal(classic.game.customer, undefined);
  assert.deepEqual([classic.game.currentDemand, classic.game.demand(5)], [4, 8]);
  // A scenario without its series, a series without its scenario, or an unknown method is dropped.
  const series = singleGame('Retailer', demand);
  for (const bad of [{ game: old, demand }, { game: series }, { game: series, demand: { method: 'random', seed: 1 } }, { game: series, demand: { method: 'sma', seed: -1 } }]) {
    storage.setItem(SINGLE_KEY, JSON.stringify({ version: 1, visibility: 'network', savedAt: 1, ...bad }));
    assert.equal(readSingle(storage), null);
    assert.equal(storage.getItem(SINGLE_KEY), null);
  }
});

test('only storage events that add or remove a multiplayer save, or change the single-player save, refresh Your games', () => {
  const key = 'beer-game.multiplayer.v2.123456.a';
  assert.equal(changesSaves({ key, oldValue: null, newValue: '{}' }), true);
  assert.equal(changesSaves({ key, oldValue: '{}', newValue: null }), true);
  assert.equal(changesSaves({ key, oldValue: '{}', newValue: '{"a":1}' }), false, 'a host checkpoint rewrite');
  assert.equal(changesSaves({ key: SINGLE_KEY, oldValue: '{}', newValue: '{"a":1}' }), true);
  assert.equal(changesSaves({ key: null, oldValue: null, newValue: null }), true, 'storage cleared');
  assert.equal(changesSaves({ key: 'other', oldValue: null, newValue: 'x' }), false);
});
