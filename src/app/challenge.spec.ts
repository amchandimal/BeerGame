import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEMAND_METHODS, demandScenario, randomDemand, rankScores, ScoreRow, singleGame } from './challenge';
import { BeerGame, ROLES } from './game';

test('all demand methods produce reproducible bounded 24-week scenarios', () => {
  for (const method of ['sma', 'wma', 'cyclic'] as const) {
    const config = { role: 'Retailer' as const, seed: 42, method };
    const demand = demandScenario(config);
    assert.deepEqual(demand, demandScenario(config));
    assert.notDeepEqual(demand, demandScenario({ ...config, seed: 99 }));
    assert.equal(demand.length, 24);
    assert.ok(demand.every(n => Number.isInteger(n) && n >= 1 && n <= 20));
  }
});

test('every challenge role receives the shared demand despite different orders; weekly costs reconcile', () => {
  for (const role of ROLES) {
    const scenario = demandScenario({ role, seed: 42, method: 'cyclic' });
    const a = new BeerGame(role, scenario), b = new BeerGame(role, scenario);
    assert.equal(a.weeklyCosts.holding + a.weeklyCosts.backorder, 0);
    for (const demand of scenario) {
      assert.equal(a.currentDemand, demand); assert.equal(b.currentDemand, demand);
      const before = a.current.cost;
      a.advance(0); b.advance(30);
      assert.equal(a.current.incoming, demand); assert.equal(b.current.incoming, demand);
      assert.equal(a.current.cost - before, a.weeklyCosts.holding + a.weeklyCosts.backorder);
    }
    assert.notEqual(a.current.cost, b.current.cost);
  }
});

test('Single Player draws the method uniformly and the seed from an injected 32-bit source, or from crypto by default', () => {
  const draws = [0, 7, 1, 4294967295, 5, 123456789, 3, 0], source = () => draws.shift()!;
  assert.deepEqual([randomDemand(source), randomDemand(source), randomDemand(source), randomDemand(source)],
    [{ method: 'sma', seed: 7 }, { method: 'wma', seed: 4294967295 }, { method: 'cyclic', seed: 123456789 }, { method: 'sma', seed: 0 }]);
  const counts = new Map<string, number>();
  for (let n = 0; n < 3000; n++) { const { method } = randomDemand(() => n); counts.set(method, (counts.get(method) ?? 0) + 1); }
  assert.deepEqual([...counts.values()], [1000, 1000, 1000], 'each method takes one third of the values');
  for (let i = 0; i < 50; i++) {
    const { method, seed } = randomDemand();
    assert.ok(DEMAND_METHODS.some(m => m.value === method) && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295);
  }
  assert.equal(new Set(Array.from({ length: 50 }, () => randomDemand().seed)).size, 50, 'crypto seeds differ between games');
});

test('a Single Player method and seed reproduce the same 24 customer demands and the same game; no scenario keeps the classic demand', () => {
  const config = { method: 'wma' as const, seed: 123456789 }, a = singleGame('Distributor', config), b = singleGame('Distributor', { ...config });
  assert.deepEqual(a.customer, demandScenario(config));
  assert.deepEqual(a.customer, b.customer);
  assert.equal(a.scenario, undefined, "the player's own demand is not replaced");
  for (const order of [4, 9, 0, 12, 6]) { a.advance(order); b.advance(order); }
  assert.deepEqual(a.history, b.history);
  const classic = singleGame('Retailer', null);
  assert.equal(classic.customer, undefined);
  assert.deepEqual(Array.from({ length: 24 }, (_, i) => classic.demand(i + 1)), [4, 4, 4, 4, ...Array(20).fill(8)]);
});

test('Single Player customer demand reaches every role through the upstream orders of the chain', () => {
  const config = { method: 'cyclic' as const, seed: 2026 }, customer = demandScenario(config);
  assert.notDeepEqual(customer, [4, 4, 4, 4, ...Array(20).fill(8)]);
  for (const [i, role] of ROLES.entries()) {
    const game = singleGame(role, config), classic = singleGame(role, null);
    for (let week = 1; week <= 24; week++) {
      if (role === 'Retailer') assert.equal(game.currentDemand, customer[week - 1]);
      game.advance(8); classic.advance(8);
    }
    const rows = game.history.map(row => row.parties);
    assert.deepEqual(game.history.map(row => row.demand), customer);
    assert.deepEqual(rows.map(p => p[0].incoming), customer, 'the Retailer receives customer demand');
    // Each upstream role receives the order its downstream neighbour placed the week before (4 in week 1).
    for (let j = 1; j < 4; j++) assert.deepEqual(rows.map(p => p[j].incoming), [4, ...rows.slice(0, -1).map(p => p[j - 1].order)]);
    assert.notDeepEqual(rows.map(p => p[i].incoming), classic.history.map(row => row.parties[i].incoming), `${role} receives the scenario, not the classic demand`);
  }
});

test('finished scores rank cost first and elapsed milliseconds break ties', () => {
  const row = (id: string, cost: number, elapsedMs: number): ScoreRow => ({ id, nickname: id, cost, elapsedMs, finished: true, connected: true, completedWeeks: 24 });
  const rows = [row('expensive-fast', 101, 1), row('cheap-slow', 100, 200), row('cheap-fast', 100, 100), { ...row('unfinished', 0, 0), finished: false, completedWeeks: 23 }];
  assert.deepEqual(rankScores(rows).map(r => r.id), ['cheap-fast', 'cheap-slow', 'expensive-fast', 'unfinished']);
  assert.equal(rows[0].id, 'expensive-fast');
});
