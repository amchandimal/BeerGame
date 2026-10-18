import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame, ROLES } from './game';
import { demandScenario } from './challenge';
import { debrief, resultsFilename, scenarioLabel } from './debrief';

const stdDev = (values: number[]) => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length); };

test('debrief costs reconcile exactly with the engine; order swing and peak backlog follow the history', () => {
  const standard = new BeerGame('Wholesaler');
  for (let week = 1; week <= 24; week++) standard.advance([4, 9, 15, 2, 0, 12][week % 6]);
  const classroom = new BeerGame('Distributor', demandScenario({ role: 'Distributor', seed: 11, method: 'wma' }));
  for (let week = 1; week <= 24; week++) classroom.advance(week % 3 * 5);
  for (const game of [standard, classroom]) {
    const d = debrief(game)!, demand = game.history.map(r => r.demand);
    assert.equal(d.weeks, 24);
    assert.equal(d.demandStdDev, stdDev(demand));
    ROLES.forEach((role, i) => {
      const r = d.roles[i], rows = game.history.map(row => row.parties[i]);
      assert.equal(r.role, role);
      assert.equal(r.holdingCost + r.backlogCost, game.parties[i].cost, `${role} cost split`);
      assert.equal(r.totalCost, game.parties[i].cost);
      assert.equal(r.peakBacklog, Math.max(...rows.map(p => p.backlog)));
      assert.equal(r.orderSwing, stdDev(rows.map(p => p.order)) / stdDev(demand));
    });
    assert.equal(d.team.totalCost, game.totalCost);
    assert.equal(d.team.holdingCost + d.team.backlogCost, game.totalCost);
    assert.equal(d.team.holdingCost, d.roles.reduce((s, r) => s + r.holdingCost, 0));
  }
  assert.ok(debrief(standard)!.roles[1].peakBacklog > 0, 'the varied orders create a backlog to report');
  assert.equal(debrief(new BeerGame('Retailer')), null);
  const flat = new BeerGame('Retailer', Array(24).fill(6));
  flat.advance(6);
  assert.equal(debrief(flat)!.roles[0].orderSwing, null, 'no swing ratio when demand never varied');
});

test('results filenames name the room or scenario, the role and the local date', () => {
  const date = new Date(2026, 9, 11);
  assert.equal(resultsFilename('Retailer', null, date), 'beer-game-standard-retailer-2026-10-11.csv');
  assert.equal(resultsFilename('Wholesaler', { name: '  Sydney Class #2! ', code: '482913' }, date), 'beer-game-sydney-class-2-482913-wholesaler-2026-10-11.csv');
  assert.equal(resultsFilename('Manufacturer', { name: '★★', code: '000123' }, new Date(2027, 0, 5)), 'beer-game-000123-manufacturer-2027-01-05.csv');
  // Single Player: the scenario once the game is over, and only "single-player" while it is hidden.
  assert.equal(resultsFilename('Distributor', { method: 'wma', seed: 123456789 }, date), 'beer-game-wma-seed-123456789-distributor-2026-10-11.csv');
  assert.equal(resultsFilename('Retailer', { method: 'cyclic', seed: 0 }, date), 'beer-game-cyclic-seed-0-retailer-2026-10-11.csv');
  assert.equal(resultsFilename('Retailer', 'single-player', date), 'beer-game-single-player-retailer-2026-10-11.csv');
  assert.deepEqual([scenarioLabel({ method: 'wma', seed: 123456789 }), scenarioLabel({ method: 'sma', seed: 7 }), scenarioLabel(null)], ['Weighted moving average · seed 123456789', 'Simple moving average · seed 7', 'Classic 4 → 8']);
});
