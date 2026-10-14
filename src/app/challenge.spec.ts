import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demandScenario, rankScores, ScoreRow } from './challenge';
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

test('finished scores rank cost first and elapsed milliseconds break ties', () => {
  const row = (id: string, cost: number, elapsedMs: number): ScoreRow => ({ id, nickname: id, cost, elapsedMs, finished: true, connected: true, completedWeeks: 24 });
  const rows = [row('expensive-fast', 101, 1), row('cheap-slow', 100, 200), row('cheap-fast', 100, 100), { ...row('unfinished', 0, 0), finished: false, completedWeeks: 23 }];
  assert.deepEqual(rankScores(rows).map(r => r.id), ['cheap-fast', 'cheap-slow', 'expensive-fast', 'unfinished']);
  assert.equal(rows[0].id, 'expensive-fast');
});
