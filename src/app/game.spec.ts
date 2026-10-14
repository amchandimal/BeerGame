import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame, ROLES } from './game';

test('all roles start balanced and remain balanced at four cases per week', () => {
  for (const role of ROLES) {
    const game = new BeerGame(role);
    for (let week = 1; week <= 4; week++) game.advance(4);
    for (const p of game.parties) {
      assert.equal(p.inventory, 12);
      assert.equal(p.backlog, 0);
      assert.equal(p.order, 4);
      assert.equal(p.cost, 24);
    }
  }
});
test('orders arrive upstream after one week and manufactured cases after two', () => {
  const retailer = new BeerGame('Retailer');
  retailer.advance(10);
  assert.equal(retailer.parties[1].incoming, 4);
  retailer.advance(4);
  assert.equal(retailer.parties[1].incoming, 10);
  const manufacturer = new BeerGame('Manufacturer');
  manufacturer.advance(17);
  assert.equal(manufacturer.current.received, 4);
  manufacturer.advance(4);
  assert.equal(manufacturer.current.received, 4);
  manufacturer.advance(4);
  assert.equal(manufacturer.current.received, 17);
});
test('inventory conservation, backlog and cumulative costs for all 24 weeks', () => {
  for (const role of ROLES) {
    const game = new BeerGame(role);
    for (let w = 0; w < 24; w++) {
      const before = game.parties.map(p => ({ ...p }));
      game.advance(w % 3 === 0 ? 0 : 10);
      game.parties.forEach((p, i) => {
        assert.equal(p.inventory, before[i].inventory + p.received - p.shipped);
        assert.equal(p.backlog, before[i].backlog + p.incoming - p.shipped);
        assert.equal(p.cost, before[i].cost + p.inventory * .5 + p.backlog);
        assert.ok(p.inventory >= 0 && p.backlog >= 0);
        assert.equal(p.shipments.length, 2);
      });
    }
    assert.ok(game.complete);
    assert.throws(() => game.advance(4));
    assert.equal(game.csv().split('\n').length, 97);
    assert.equal(game.history[4].demand, 8);
  }
});
test('invalid orders do not mutate the simulation', () => {
  const game = new BeerGame('Retailer');
  for (const value of [-1, 101, 1.5, NaN]) assert.throws(() => game.advance(value));
  assert.equal(game.week, 1);
  assert.equal(game.current.inventory, 12);
});
test('multiplayer uses all four human orders with the same lead times', () => {
  const game = new BeerGame('Retailer');
  game.advanceMultiplayer({ Retailer: 10, Wholesaler: 7, Distributor: 6, Manufacturer: 17 });
  assert.deepEqual(game.parties.map(p => p.order), [10, 7, 6, 17]);
  game.advanceMultiplayer({ Retailer: 4, Wholesaler: 4, Distributor: 4, Manufacturer: 4 });
  assert.deepEqual(game.parties.map(p => p.incoming), [4, 10, 7, 6]);
  game.advanceMultiplayer({ Retailer: 4, Wholesaler: 4, Distributor: 4, Manufacturer: 4 });
  assert.equal(game.parties[3].received, 17);
});
test('multiplayer rejects missing or invalid orders before mutating a turn', () => {
  const game = new BeerGame('Retailer');
  assert.throws(() => game.advanceMultiplayer({ Retailer: 4 } as any));
  assert.throws(() => game.advanceMultiplayer({ Retailer: 4, Wholesaler: -1, Distributor: 4, Manufacturer: 4 }));
  assert.equal(game.week, 1);
  assert.equal(game.current.inventory, 12);
});
test('one human in multiplayer matches single-player automation for every role', () => {
  for (const role of ROLES) {
    const single = new BeerGame(role);
    const multi = new BeerGame(role);
    for (let week = 0; week < 24; week++) {
      const amount = week % 3 === 0 ? 0 : 10;
      single.advance(amount);
      multi.advanceMultiplayer({ [role]: amount }, [role]);
      assert.deepEqual(multi.history, single.history);
    }
  }
});
test('two and three human players keep their orders and automate only empty roles', () => {
  for (const humans of [['Retailer', 'Manufacturer'], ['Retailer', 'Wholesaler', 'Manufacturer']] as const) {
    const game = new BeerGame('Retailer');
    const orders = Object.fromEntries(humans.map((role, i) => [role, 10 + i])) as Partial<Record<typeof ROLES[number], number>>;
    game.advanceMultiplayer(orders, humans);
    for (const p of game.parties) assert.equal(p.order, orders[p.role] ?? 4);
    game.advanceMultiplayer(orders, humans);
    game.advanceMultiplayer(orders, humans);
    assert.equal(game.parties[3].received, orders.Manufacturer);
  }
});
test('mixed play validates every human order before mutating and rejects system overrides', () => {
  const game = new BeerGame('Retailer');
  assert.throws(() => game.advanceMultiplayer({ Retailer: 4 }, ['Retailer', 'Wholesaler']));
  assert.throws(() => game.advanceMultiplayer({ Retailer: 4, Manufacturer: 9 }, ['Retailer']));
  assert.throws(() => game.advanceMultiplayer({ Retailer: NaN }, ['Retailer']));
  assert.throws(() => game.advanceMultiplayer({ Retailer: 4 }, []));
  assert.equal(game.week, 1);
  assert.equal(game.current.inventory, 12);
});

test('current demand previews this week, respecting customer changes and order delay', () => {
  const retailer = new BeerGame('Retailer');
  assert.equal(retailer.currentDemand, 4);
  for (let week = 1; week <= 4; week++) retailer.advance(4);
  assert.equal(retailer.current.incoming, 4);
  assert.equal(retailer.currentDemand, 8);
  for (const role of ROLES.slice(1)) {
    const game = new BeerGame(role);
    assert.equal(game.currentDemand, 4);
    game.advanceMultiplayer({ Retailer: 11, Wholesaler: 17, Distributor: 23, Manufacturer: 31 });
    const expected = { Wholesaler: 11, Distributor: 17, Manufacturer: 23 }[role];
    assert.equal(game.current.incoming, 4);
    assert.equal(game.currentDemand, expected);
    game.advance(4);
    assert.equal(game.current.incoming, expected);
  }
});
