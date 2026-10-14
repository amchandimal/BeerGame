import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BeerGame } from './game';
import { createGameAgent } from './game-agent';

function fixture() {
  const multi: any = { room: null, game: null, ready: false, isHost: false, submitted: false,
    error: '', status: 'Not connected', pending: {}, humanRoles: [], activeRoles: [], systemRoles: [], absences: [], replaced: false,
    connected: () => false, memberStatus: () => 'Ready', lobbySummary: '', awayMembers: [], startWithout: null, startReview: [], get chain() { return this.room; }, leave() { this.room = null; this.game = null; } };
  const app: any = { mode: null, selected: null, game: null, multi, order: 4, error: '', inviteUrl: '',
    start() { this.game = new BeerGame(this.selected); }, reset() { this.multi.leave(); this.mode = null; this.selected = null; this.game = null; } };
  return { app, agent: createGameAgent(app, () => {}) };
}
test('AI plays a complete single-player game and reads history/CSV without mutating state', async () => {
  const { agent } = fixture();
  const initial: any = await agent.command({ type: 'single', role: 'Retailer' });
  assert.equal(initial.week, 1);
  assert.deepEqual(initial.systemRoles, ['Wholesaler', 'Distributor', 'Manufacturer']);
  assert.deepEqual(initial.parties[0].inTransit, [{ quantity: 4, arrivesWeek: 1, leadTimeWeeks: 1 }, { quantity: 4, arrivesWeek: 2, leadTimeWeeks: 2 }]);
  for (let week = 1; week <= 24; week++) await agent.command({ type: 'order', week, amount: 4 });
  const end = agent.state();
  assert.equal(end.complete, true);
  assert.equal(end.canOrder, false);
  assert.equal((await agent.command({ type: 'history' }) as any).history.length, 24);
  assert.equal((await agent.command({ type: 'export' }) as any).csv.split('\n').length, 97);
  await assert.rejects(agent.command({ type: 'order', week: 24, amount: 4 }), /no active game/);
});
test('AI rejects stale and invalid orders without advancing, and refuses to replace an active session', async () => {
  const { agent } = fixture();
  await agent.command({ type: 'single', role: 'Manufacturer' });
  await assert.rejects(agent.command({ type: 'order', week: 2, amount: 4 }), /Stale order/);
  await assert.rejects(agent.command({ type: 'order', week: 1, amount: 4.5 }), /whole number/);
  assert.equal(agent.state().week, 1);
  await assert.rejects(agent.command({ type: 'single', role: 'Retailer' }), /already has a session/);
  await agent.command({ type: 'order', week: 1, amount: 10 });
  await assert.rejects(agent.command({ type: 'order', week: 1, amount: 10 }), /Stale order/);
  await agent.command({ type: 'leave' });
  assert.equal(agent.state().phase, 'idle');
});
test('AI guests in a four-player RTC star need only their creator channel; duplicate orders are rejected', async () => {
  const { app, agent } = fixture();
  app.mode = 'multi'; app.selected = 'Wholesaler';
  const multi = app.multi;
  multi.room = { name: 'Test', code: '123456', started: true, host: 'host', humanRoles: ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'], members: ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'].map((role, i) => ({ id: i === 0 ? 'host' : `${i}`, role })) };
  multi.humanRoles = multi.activeRoles = multi.room.humanRoles;
  multi.game = new BeerGame('Wholesaler');
  multi.connected = (id: string) => id === 'host';
  multi.submit = (amount: number) => { multi.pending.Wholesaler = amount; multi.submitted = true; };
  assert.equal(agent.state().canOrder, true);
  await agent.command({ type: 'order', week: 1, amount: 7 });
  assert.equal(agent.state().pendingOrders.Wholesaler, 7);
  await assert.rejects(agent.command({ type: 'order', week: 1, amount: 8 }), /already submitted/);
  await assert.rejects(agent.command({ type: 'start' }), /Only the multiplayer host/);
  const waiting: any = await agent.command({ type: 'wait', afterWeek: 1, timeoutMs: 0 });
  assert.equal(waiting.week, 1);
  assert.deepEqual(waiting.waitingFor, ['Retailer', 'Distributor', 'Manufacturer']);
  // Without the host's reply, ordering again re-sends the same order (the host records one per week); otherwise a second order is refused with the status.
  let resent = 0;
  multi.resend = () => resent++;
  multi.orderStatus = { week: 1, amount: 7, state: 'unconfirmed', waitingFor: [], message: 'No reply from the host yet. Send your week 1 order (7 cases) again.', canRetry: true };
  assert.deepEqual((await agent.command({ type: 'order', week: 1, amount: 9 }) as any).orderStatus, multi.orderStatus);
  assert.equal(resent, 1); assert.equal(multi.pending.Wholesaler, 7);
  multi.orderStatus = { ...multi.orderStatus, state: 'accepted', message: 'Accepted for week 1: 7 cases. Waiting for Alex.', canRetry: false };
  await assert.rejects(agent.command({ type: 'order', week: 1, amount: 7 }), /already submitted an order this week\. Accepted for week 1: 7 cases\. Waiting for Alex\./);
  assert.equal(resent, 1);
});

test('MCP state, pending orders, history and exports follow creator visibility even on the host', async () => {
  const { app, agent } = fixture();
  await agent.command({ type: 'single', role: 'Distributor', visibility: 'none' });
  await agent.command({ type: 'order', week: 1, amount: 8 });
  let state = agent.state();
  assert.equal(state.visibility, 'none'); assert.equal(state.teamCost, null);
  assert.deepEqual(state.parties.map(p => p.role), ['Distributor']);
  assert.equal(state.lastWeek!.demand, null);
  assert.equal(state.leadTimes.production, null);
  assert.equal((await agent.command({ type: 'export' }) as any).csv.split('\n').length, 2);
  app.mode = 'multi'; app.multi.isHost = true;
  app.multi.game = app.game;
  app.multi.room = { visibility: 'dyadic', members: [], name: 'Scoped' };
  app.multi.pending = { Retailer: 99, Wholesaler: 4, Manufacturer: 3 };
  app.multi.submittedRoles = ['Retailer', 'Wholesaler', 'Manufacturer'];
  state = agent.state();
  assert.equal(state.visibility, 'dyadic');
  assert.deepEqual(state.parties.map(p => p.role), ['Wholesaler', 'Distributor', 'Manufacturer']);
  assert.deepEqual(state.pendingOrders, { Wholesaler: 4, Manufacturer: 3 });
  assert.deepEqual(state.submittedRoles, ['Retailer', 'Wholesaler', 'Manufacturer']);
  const result: any = await agent.command({ type: 'history' });
  assert.deepEqual(result.history[0].parties.map((p: any) => p.role), ['Wholesaler', 'Distributor', 'Manufacturer']);
  assert.equal(result.history[0].demand, null);
});

test('MCP current demand matches the decision week for every role and visibility', async () => {
  for (const visibility of ['network', 'dyadic', 'none'] as const) {
    for (const [role, source, amount] of [['Retailer', 'Customers', 8], ['Wholesaler', 'Retailer', 11], ['Distributor', 'Wholesaler', 17], ['Manufacturer', 'Distributor', 23]] as const) {
      const { app, agent } = fixture();
      assert.equal(agent.state().currentDemand, null);
      await agent.command({ type: 'single', role, visibility });
      assert.equal(agent.state().currentDemand!.quantity, 4);
      if (role === 'Retailer') {
        for (let week = 1; week <= 4; week++) await agent.command({ type: 'order', week, amount: 4 });
      } else {
        app.game.advanceMultiplayer({ Retailer: 11, Wholesaler: 17, Distributor: 23, Manufacturer: 31 });
      }
      assert.deepEqual(agent.state().currentDemand, {
        week: app.game.week, quantity: amount, unit: 'cases', label: app.game.demandLabel,
        source, orderLeadTimeWeeks: role === 'Retailer' ? 0 : 1, includesBacklog: false
      });
      assert.equal(app.game.current.incoming, 4);
      app.mode = 'multi'; app.multi.game = app.game; app.multi.room = { visibility, members: [] };
      assert.equal(agent.state().currentDemand!.quantity, amount);
      while (!app.game.complete) app.game.advance(4);
      assert.equal(agent.state().currentDemand, null);
    }
  }
});
