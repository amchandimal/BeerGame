import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from 'ws';
import { createSignalingServer } from '../server/index.mjs';

test('real stdio MCP plays single-player and four WebRTC players for 24 weeks', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const client = new Client({ name: 'integration-player', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./index.mjs', import.meta.url))],
    env: { ...process.env, BEER_GAME_URL: `http://127.0.0.1:${server.address().port}`, BEER_GAME_HEADLESS: 'true' }, stderr: 'pipe' });
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, result.content?.[0]?.text);
    return result.structuredContent;
  };
  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 17);
    // Default: a random seeded customer demand, named only once the game is complete.
    const single = await call('beer_game_create_single', { role: 'Manufacturer' });
    assert.equal(single.demandScenario, null);
    for (let week = 1; week <= 23; week++) await call('beer_game_order', { sessionId: single.sessionId, week, amount: 4 });
    assert.equal((await call('beer_game_state', { sessionId: single.sessionId })).demandScenario, null);
    assert.match((await call('beer_game_export', { sessionId: single.sessionId })).filename, /^beer-game-single-player-manufacturer-/);
    await call('beer_game_order', { sessionId: single.sessionId, week: 24, amount: 4 });
    const end = await call('beer_game_state', { sessionId: single.sessionId });
    const { method, seed, label } = end.demandScenario;
    assert.ok(['sma', 'wma', 'cyclic'].includes(method) && Number.isInteger(seed) && seed >= 0 && seed <= 4294967295, JSON.stringify(end.demandScenario));
    assert.ok(label.endsWith(` · seed ${seed}`), label);
    assert.equal((await call('beer_game_export', { sessionId: single.sessionId })).filename.replace(/\d{4}-\d{2}-\d{2}\.csv$/, ''), `beer-game-${method}-seed-${seed}-manufacturer-`);
    const randomDemand = (await call('beer_game_history', { sessionId: single.sessionId })).history.map(row => row.demand);
    assert.equal(end.completedWeeks, 24); assert.equal(end.complete, true);
    assert.equal((await call('beer_game_history', { sessionId: single.sessionId })).history.length, 24);
    assert.equal((await call('beer_game_export', { sessionId: single.sessionId })).csv.split('\n').length, 97);
    assert.equal(end.revealed, true); assert.deepEqual(end.revealedRoles, []); assert.equal(end.debrief.team.totalCost, end.teamCost);
    await call('beer_game_close', { sessionId: single.sessionId });
    // A method and seed reproduce that game's customer demand; it reaches the Distributor through the system players' orders.
    const seeded = [];
    for (const role of ['Retailer', 'Distributor']) {
      const again = await call('beer_game_create_single', { role, demand: { method, seed } });
      for (let week = 1; week <= 24; week++) await call('beer_game_order', { sessionId: again.sessionId, week, amount: 6 });
      const history = (await call('beer_game_history', { sessionId: again.sessionId })).history;
      seeded.push(history);
      assert.deepEqual(history.map(row => row.demand), randomDemand);
      assert.deepEqual((await call('beer_game_state', { sessionId: again.sessionId })).demandScenario, { method, seed, label });
      await call('beer_game_close', { sessionId: again.sessionId });
    }
    assert.deepEqual(seeded[0].map(row => row.parties[0].incoming), randomDemand);
    assert.deepEqual(seeded[1].map(row => row.parties[2].incoming), [4, ...seeded[1].slice(0, -1).map(row => row.parties[1].order)]);
    // Single-player None: own role only until week 24 completes, then the whole chain, its team cost and the debrief.
    const hidden = await call('beer_game_create_single', { role: 'Manufacturer', visibility: 'none', demand: 'standard' }); // The classic 4 → 8.
    for (let week = 1; week <= 23; week++) await call('beer_game_order', { sessionId: hidden.sessionId, week, amount: week % 4 * 3 });
    const playing = await call('beer_game_state', { sessionId: hidden.sessionId });
    assert.deepEqual(playing.parties.map(p => p.role), ['Manufacturer']); assert.equal(playing.revealed, false);
    assert.equal(playing.teamCost, null); assert.equal(playing.debrief, null); assert.equal(playing.lastWeek.demand, null);
    assert.equal((await call('beer_game_export', { sessionId: hidden.sessionId })).csv.split('\n').length, 24);
    const shown = await call('beer_game_order', { sessionId: hidden.sessionId, week: 24, amount: 8 });
    assert.equal(shown.visibility, 'none'); assert.equal(shown.revealed, true); assert.deepEqual(shown.revealedRoles, ['Retailer', 'Wholesaler', 'Distributor']);
    assert.deepEqual(shown.parties.map(p => p.role), ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer']);
    assert.equal(shown.lastWeek.demand, 8); assert.equal(shown.debrief.team.totalCost, shown.teamCost);
    for (const [i, row] of shown.debrief.roles.entries()) assert.equal(row.holdingCost + row.backlogCost, shown.parties[i].cost);
    assert.ok((await call('beer_game_history', { sessionId: hidden.sessionId })).history.every(row => row.parties.length === 4 && row.demand !== null));
    const shownCsv = await call('beer_game_export', { sessionId: hidden.sessionId });
    assert.equal(shownCsv.csv.split('\n').length, 97); assert.match(shownCsv.filename, /^beer-game-standard-manufacturer-\d{4}-\d{2}-\d{2}\.csv$/);
    assert.deepEqual(shown.demandScenario, { method: 'standard', seed: null, label: 'Classic 4 → 8' });
    await call('beer_game_close', { sessionId: hidden.sessionId });
    const host = await call('beer_game_create_chain', { name: 'MCP Integration Chain', role: 'Retailer' });
    const players = [host];
    for (const role of ['Wholesaler', 'Distributor', 'Manufacturer']) players.push(await call('beer_game_join_chain', { name: host.room.name, code: host.room.code, role }));
    await call('beer_game_wait', { sessionId: host.sessionId, timeoutMs: 15000 });
    await call('beer_game_start', { sessionId: host.sessionId });
    for (const player of players.slice(1)) await call('beer_game_wait', { sessionId: player.sessionId, afterWeek: 0, timeoutMs: 15000 });
    const stale = await client.callTool({ name: 'beer_game_order', arguments: { sessionId: host.sessionId, week: 2, amount: 4 } });
    assert.equal(stale.isError, true);
    for (let week = 1; week <= 24; week++) {
      await call('beer_game_order', { sessionId: host.sessionId, week, amount: 10 });
      if (week === 1) {
        const pending = await call('beer_game_state', { sessionId: host.sessionId });
        assert.equal(pending.week, 1); assert.equal(pending.pendingOrders.Retailer, 10);
        assert.equal(pending.orderStatus.state, 'accepted'); assert.equal(pending.orderStatus.amount, 10); assert.equal(pending.orderStatus.canRetry, false);
        assert.equal(pending.orderStatus.waitingFor.length, 3); assert.match(pending.orderStatus.message, /^Accepted for week 1: 10 cases\. Waiting for .+, .+ and .+\.$/);
        const duplicate = await client.callTool({ name: 'beer_game_order', arguments: { sessionId: host.sessionId, week: 1, amount: 10 } });
        assert.equal(duplicate.isError, true); assert.match(duplicate.content[0].text, /already submitted an order this week\. Accepted for week 1: 10 cases\./);
      }
      for (const [i, player] of players.slice(1).entries()) await call('beer_game_order', { sessionId: player.sessionId, week, amount: [7, 6, 17][i] });
      for (const player of players) {
        const state = await call('beer_game_wait', { sessionId: player.sessionId, afterWeek: week, timeoutMs: 10000 });
        assert.equal(state.week, week + 1);
      }
    }
    const states = await Promise.all(players.map(player => call('beer_game_state', { sessionId: player.sessionId })));
    assert.ok(states.every(state => state.complete && state.completedWeeks === 24));
    assert.ok(states.every(state => state.teamCost === states[0].teamCost));
    assert.deepEqual(states[0].lastWeek.parties.map(p => p.order), [10, 7, 6, 17]);
    assert.ok(states.every(state => state.revealed && state.debrief.team.totalCost === state.teamCost));
    assert.match((await call('beer_game_export', { sessionId: players[1].sessionId })).filename, /^beer-game-mcp-integration-chain-\d{6}-wholesaler-\d{4}-\d{2}-\d{2}\.csv$/);
    for (const player of players.slice(1)) await call('beer_game_close', { sessionId: player.sessionId });
    await call('beer_game_close', { sessionId: host.sessionId });
    const solo = await call('beer_game_create_chain', { name: 'AI plus system', role: 'Distributor' });
    await call('beer_game_start', { sessionId: solo.sessionId });
    const mixed = await call('beer_game_order', { sessionId: solo.sessionId, week: 1, amount: 9 });
    assert.equal(mixed.week, 2);
    assert.equal(mixed.lastWeek.parties[2].order, 9);
    assert.equal(mixed.systemRoles.length, 3);
    await call('beer_game_close', { sessionId: solo.sessionId });
    // Closing a started team guest keeps the seat; the AI creator answers the prompt and play continues.
    const seatHost = await call('beer_game_create_chain', { name: 'Seat keeping', role: 'Retailer', nickname: 'Creator' });
    const leaver = await call('beer_game_join_chain', { code: seatHost.room.code, role: 'Wholesaler', nickname: 'Leaver' });
    await call('beer_game_wait', { sessionId: seatHost.sessionId, timeoutMs: 15000 });
    await call('beer_game_start', { sessionId: seatHost.sessionId });
    await call('beer_game_wait', { sessionId: leaver.sessionId, afterWeek: 0, timeoutMs: 15000 });
    await call('beer_game_close', { sessionId: leaver.sessionId });
    let asked; const askedBy = Date.now() + 5000;
    do asked = await call('beer_game_state', { sessionId: seatHost.sessionId }); while (!asked.absentPlayers.some(a => a.state === 'left') && Date.now() < askedBy);
    assert.deepEqual(asked.absentPlayers.map(a => [a.role, a.state, a.canDecide, a.message]), [['Wholesaler', 'left', true, 'Leaver (Wholesaler) has left. Let the system play Wholesaler, or keep waiting?']]);
    assert.equal(asked.room.members.length, 2); assert.equal(asked.canOrder, false);
    const decided = await call('beer_game_decide', { sessionId: seatHost.sessionId, role: 'Wholesaler', systemPlays: true });
    assert.equal(decided.absentPlayers[0].decidedBy, 'Creator'); assert.ok(decided.systemRoles.includes('Wholesaler'));
    assert.equal((await client.callTool({ name: 'beer_game_decide', arguments: { sessionId: seatHost.sessionId, role: 'Wholesaler', systemPlays: false } })).isError, true);
    assert.equal((await call('beer_game_order', { sessionId: seatHost.sessionId, week: 1, amount: 9 })).week, 2);
    await call('beer_game_close', { sessionId: seatHost.sessionId });
    // Lobby: an AI player changes role; the AI host removes a disconnected member and starts without another, whose seat the system plays.
    const lobbyHost = await call('beer_game_create_chain', { name: 'Lobby moves', role: 'Retailer', nickname: 'Creator' });
    const mover = await call('beer_game_join_chain', { code: lobbyHost.room.code, role: 'Wholesaler', nickname: 'Mover' });
    assert.equal((await client.callTool({ name: 'beer_game_change_role', arguments: { sessionId: mover.sessionId, role: 'Retailer' } })).isError, true);
    assert.equal((await call('beer_game_change_role', { sessionId: mover.sessionId, role: 'Distributor' })).role, 'Distributor');
    // Raw signaling clients join, then drop the connection without leaving, so their memberships stay reserved.
    for (const [nickname, role] of [['Gone', null], ['Away', 'Manufacturer']]) {
      const socket = new WebSocket(`ws://127.0.0.1:${server.address().port}/signaling`), inbox = [];
      socket.on('message', raw => inbox.push(JSON.parse(raw.toString())));
      await once(socket, 'open');
      for (const message of [{ type: 'join', code: lobbyHost.room.code }, { type: 'nickname', nickname }, ...role ? [{ type: 'claim', role }] : []]) socket.send(JSON.stringify(message));
      const joinedBy = Date.now() + 5000;
      while (!inbox.some(m => m.type === 'room' && m.room.members.some(p => p.nickname === nickname && p.role === role)) && Date.now() < joinedBy) await new Promise(r => setTimeout(r, 20));
      socket.close(); await once(socket, 'close');
    }
    let lobby; const awayBy = Date.now() + 5000;
    do lobby = await call('beer_game_state', { sessionId: lobbyHost.sessionId }); while (lobby.room.members.filter(m => m.canRemove).length < 2 && Date.now() < awayBy);
    assert.deepEqual(lobby.room.members.map(m => [m.nickname, m.canRemove]), [['Creator', false], ['Mover', false], ['Gone', true], ['Away', true]]);
    assert.equal(lobby.startWithout.message, 'Start without Gone and Away? Their role will be played by the system.');
    const [gone, away] = ['Gone', 'Away'].map(nickname => lobby.room.members.find(m => m.nickname === nickname).id);
    assert.equal((await client.callTool({ name: 'beer_game_remove_player', arguments: { sessionId: lobbyHost.sessionId, playerId: lobby.room.members[1].id } })).isError, true);
    const trimmed = await call('beer_game_remove_player', { sessionId: lobbyHost.sessionId, playerId: gone });
    assert.deepEqual(trimmed.room.members.map(m => m.nickname), ['Creator', 'Mover', 'Away']);
    assert.deepEqual(trimmed.startWithout, { playerIds: [away], message: 'Start without Away? Their role will be played by the system.' });
    assert.deepEqual(trimmed.startReview.slice(2), [{ label: 'Players', value: 'Creator (Retailer), Mover (Distributor), Away (Manufacturer)' }, { label: 'System plays', value: 'Wholesaler' }]);
    assert.equal((await client.callTool({ name: 'beer_game_start', arguments: { sessionId: lobbyHost.sessionId } })).isError, true);
    const begun = await call('beer_game_start', { sessionId: lobbyHost.sessionId, withoutDisconnected: true });
    assert.equal(begun.phase, 'playing'); assert.deepEqual(begun.systemRoles, ['Wholesaler', 'Manufacturer']);
    assert.deepEqual(begun.absentPlayers.map(a => [a.state, a.message]), [['system', 'Away (Manufacturer) was offline at the start. The system is playing Manufacturer (decided by Creator).']]);
    await call('beer_game_wait', { sessionId: mover.sessionId, afterWeek: 0, timeoutMs: 15000 });
    await call('beer_game_order', { sessionId: lobbyHost.sessionId, week: 1, amount: 6 });
    await call('beer_game_order', { sessionId: mover.sessionId, week: 1, amount: 5 });
    assert.equal((await call('beer_game_wait', { sessionId: lobbyHost.sessionId, afterWeek: 1, timeoutMs: 10000 })).week, 2);
    await call('beer_game_close', { sessionId: mover.sessionId });
    await call('beer_game_close', { sessionId: lobbyHost.sessionId });
    for (const visibility of ['dyadic', 'none']) {
      const scopedHost = await call('beer_game_create_chain', { name: `Visibility ${visibility}`, role: 'Retailer', visibility });
      const scopedPlayers = [scopedHost];
      for (const role of ['Wholesaler', 'Distributor', 'Manufacturer']) scopedPlayers.push(await call('beer_game_join_chain', { name: scopedHost.room.name, code: scopedHost.room.code, role }));
      await call('beer_game_wait', { sessionId: scopedHost.sessionId, timeoutMs: 15000 });
      await call('beer_game_start', { sessionId: scopedHost.sessionId });
      for (const player of scopedPlayers.slice(1)) await call('beer_game_wait', { sessionId: player.sessionId, afterWeek: 0, timeoutMs: 15000 });
      const all = ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'], dyadic = { Retailer: ['Retailer', 'Wholesaler'], Wholesaler: ['Retailer', 'Wholesaler', 'Distributor'], Distributor: ['Wholesaler', 'Distributor', 'Manufacturer'], Manufacturer: ['Distributor', 'Manufacturer'] };
      for (let week = 1; week <= 24; week++) {
        await call('beer_game_order', { sessionId: scopedHost.sessionId, week, amount: 13 });
        if (week === 1) {
          const factory = scopedPlayers[3];
          const deadline = Date.now() + 3000;
          let pending;
          do {
            pending = await call('beer_game_state', { sessionId: factory.sessionId });
            if (pending.submittedRoles.includes('Retailer')) break;
            await new Promise(resolve => setTimeout(resolve, 20));
          } while (Date.now() < deadline);
          assert.ok(pending.submittedRoles.includes('Retailer'));
          assert.equal(pending.pendingOrders.Retailer, undefined);
          assert.equal(pending.week, 1);
        }
        for (const player of scopedPlayers.slice(1)) await call('beer_game_order', { sessionId: player.sessionId, week, amount: 7 });
        // Hidden data stays hidden through week 23; completing week 24 reveals the whole chain to every player.
        const revealed = week === 24, final = [];
        for (const player of scopedPlayers) {
          const state = await call('beer_game_wait', { sessionId: player.sessionId, afterWeek: week, timeoutMs: 10000 });
          assert.equal(state.week, week + 1);
          const scoped = visibility === 'none' ? [state.role] : dyadic[state.role], expected = revealed ? all : scoped;
          assert.equal(state.visibility, visibility); assert.equal(state.room.visibility, visibility);
          assert.equal(state.revealed, revealed); assert.deepEqual(state.revealedRoles, revealed ? all.filter(role => !scoped.includes(role)) : []);
          assert.deepEqual(state.parties.map(p => p.role), expected);
          assert.deepEqual(state.lastWeek.parties.map(p => p.role), expected);
          assert.equal(state.teamCost === null, !revealed); assert.equal(state.debrief === null, !revealed);
          if (!expected.includes('Retailer')) assert.equal(state.lastWeek.demand, null);
          if (week === 23) {
            assert.ok((await call('beer_game_history', { sessionId: player.sessionId })).history.every(row => row.parties.length === scoped.length && (scoped.includes('Retailer') || row.demand === null)));
            assert.equal((await call('beer_game_export', { sessionId: player.sessionId })).csv.split('\n').length, 1 + scoped.length * 23);
          }
          final.push(state);
        }
        if (revealed) for (const state of final) assert.deepEqual([state.teamCost, state.debrief, state.lastWeek], [final[0].teamCost, final[0].debrief, final[0].lastWeek]);
      }
      for (const player of scopedPlayers) {
        const result = await call('beer_game_history', { sessionId: player.sessionId });
        assert.equal(result.history.length, 24); assert.equal(result.revealed, true);
        assert.ok(result.history.every(row => row.parties.length === 4 && row.demand !== null));
        const exported = await call('beer_game_export', { sessionId: player.sessionId });
        assert.equal(exported.csv.split('\n').length, 1 + 4 * 24);
      }
      for (const player of scopedPlayers.slice(1)) await call('beer_game_close', { sessionId: player.sessionId });
      await call('beer_game_close', { sessionId: scopedHost.sessionId });
    }
    const classroom = await call('beer_game_create_chain', { name: 'Classroom', role: 'Distributor', nickname: 'Teacher', kind: 'classroom', visibility: 'none', challenge: { role: 'Distributor', seed: 42, method: 'cyclic' } });
    assert.match(classroom.room.code, /^\d{6}$/);
    const competitors = [classroom];
    for (let i = 1; i <= 4; i++) competitors.push(await call('beer_game_join_chain', { code: classroom.room.code, nickname: `Student ${i}` }));
    await call('beer_game_wait', { sessionId: classroom.sessionId, timeoutMs: 15000 });
    await call('beer_game_start', { sessionId: classroom.sessionId });
    const guest = competitors[1];
    await call('beer_game_wait', { sessionId: guest.sessionId, afterWeek: 0, timeoutMs: 15000 });
    for (let week = 1; week <= 24; week++) await call('beer_game_order', { sessionId: classroom.sessionId, week, amount: 8 });
    // The creator's run is complete, but others are still playing: nothing is revealed yet.
    const waitingTeacher = await call('beer_game_state', { sessionId: classroom.sessionId });
    assert.equal(waitingTeacher.phase, 'complete'); assert.equal(waitingTeacher.revealed, false); assert.equal(waitingTeacher.debrief, null);
    assert.deepEqual(waitingTeacher.parties.map(p => p.role), ['Distributor']);
    assert.equal((await call('beer_game_export', { sessionId: classroom.sessionId })).csv.split('\n').length, 25);
    const untouched = await call('beer_game_state', { sessionId: guest.sessionId });
    assert.equal(untouched.week, 1); assert.equal(untouched.role, 'Distributor');
    assert.equal(untouched.room.members.length, 5);
    // An idle competitor leaving must not block remaining independent runs.
    await call('beer_game_close', { sessionId: competitors[4].sessionId });
    for (let week = 1; week <= 24; week++) {
      await call('beer_game_order', { sessionId: guest.sessionId, week, amount: 8 });
      const result = await call('beer_game_wait', { sessionId: guest.sessionId, afterWeek: week, timeoutMs: 10000 });
      assert.equal(result.week, week + 1);
      assert.deepEqual(result.parties.map(p => p.role), ['Distributor']);
      assert.equal(result.weeklyCosts.week, week);
    }
    const scores = (await call('beer_game_state', { sessionId: classroom.sessionId })).leaderboard;
    assert.equal(scores.filter(r => r.finished).length, 2);
    assert.equal(scores[0].nickname, 'Teacher');
    assert.equal(scores[0].cost, scores[1].cost);
    assert.ok(scores[0].elapsedMs < scores[1].elapsedMs);
    assert.equal(scores.find(r => r.nickname === 'Student 4').connected, false);
    assert.deepEqual((await call('beer_game_state', { sessionId: classroom.sessionId })).classroomCounts, { playing: 2, disconnected: 1, finished: 2, incomplete: 0 });
    const hostHistory = (await call('beer_game_history', { sessionId: classroom.sessionId })).history;
    const guestHistory = (await call('beer_game_history', { sessionId: guest.sessionId })).history;
    assert.deepEqual(hostHistory, guestHistory);
    assert.equal((await call('beer_game_state', { sessionId: guest.sessionId })).revealed, false);
    // Finish classroom: only the creator can, unfinished runs stop as incomplete, and each player's own run is revealed.
    assert.equal((await client.callTool({ name: 'beer_game_finish_classroom', arguments: { sessionId: guest.sessionId } })).isError, true);
    const finishedClass = await call('beer_game_finish_classroom', { sessionId: classroom.sessionId });
    assert.equal(finishedClass.revealed, true);
    assert.deepEqual(finishedClass.leaderboard.map(r => [r.nickname, r.finished, r.incomplete]), [['Teacher', true, false], ['Student 1', true, false], ['Student 2', false, true], ['Student 3', false, true], ['Student 4', false, true]]);
    assert.deepEqual(finishedClass.parties.map(p => p.role), ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer']);
    assert.equal(finishedClass.debrief.team.totalCost, finishedClass.teamCost);
    assert.equal((await client.callTool({ name: 'beer_game_finish_classroom', arguments: { sessionId: classroom.sessionId } })).isError, true);
    let shownGuest; const shownBy = Date.now() + 5000;
    do shownGuest = await call('beer_game_state', { sessionId: guest.sessionId }); while (!shownGuest.revealed && Date.now() < shownBy);
    assert.deepEqual(shownGuest.revealedRoles, ['Retailer', 'Wholesaler', 'Manufacturer']); assert.equal(shownGuest.parties.length, 4);
    assert.deepEqual((await call('beer_game_history', { sessionId: guest.sessionId })).history, (await call('beer_game_history', { sessionId: classroom.sessionId })).history);
    assert.equal((await call('beer_game_export', { sessionId: guest.sessionId })).csv.split('\n').length, 97);
    let stopped; const stoppedBy = Date.now() + 5000;
    do stopped = await call('beer_game_state', { sessionId: competitors[2].sessionId }); while (!stopped.revealed && Date.now() < stoppedBy);
    assert.equal(stopped.phase, 'complete'); assert.equal(stopped.canOrder, false); assert.equal(stopped.completedWeeks, 0); assert.equal(stopped.parties.length, 4);
    assert.equal((await client.callTool({ name: 'beer_game_order', arguments: { sessionId: competitors[2].sessionId, week: 1, amount: 8 } })).isError, true);
    for (const player of competitors.slice(1, 4)) await call('beer_game_close', { sessionId: player.sessionId });
    await call('beer_game_close', { sessionId: classroom.sessionId });
    const observer = await call('beer_game_create_chain', { name: 'Teacher observing', role: 'Retailer', kind: 'classroom', hostPlays: false, nickname: 'Observer' });
    assert.equal(observer.isObserver, true); assert.equal(observer.role, null);
    assert.equal(observer.canStart, false);
    const emptyStart = await client.callTool({ name: 'beer_game_start', arguments: { sessionId: observer.sessionId } });
    assert.equal(emptyStart.isError, true);
    const student = await call('beer_game_join_chain', { code: observer.room.code, nickname: 'Learner' });
    await call('beer_game_wait', { sessionId: observer.sessionId, timeoutMs: 15000 });
    const watching = await call('beer_game_start', { sessionId: observer.sessionId });
    assert.equal(watching.phase, 'observing'); assert.equal(watching.canOrder, false);
    assert.deepEqual(watching.parties, []); assert.equal(watching.leaderboard.length, 1);
    assert.equal(watching.leaderboard[0].nickname, 'Learner');
    const observerOrder = await client.callTool({ name: 'beer_game_order', arguments: { sessionId: observer.sessionId, week: 1, amount: 4 } });
    assert.equal(observerOrder.isError, true);
    await call('beer_game_wait', { sessionId: student.sessionId, afterWeek: 0, timeoutMs: 15000 });
    for (let week = 1; week <= 24; week++) {
      await call('beer_game_order', { sessionId: student.sessionId, week, amount: 8 });
      const advanced = await call('beer_game_wait', { sessionId: student.sessionId, afterWeek: week, timeoutMs: 10000 });
      const dashboard = await call('beer_game_state', { sessionId: observer.sessionId });
      assert.equal(dashboard.phase, 'observing');
      assert.equal(dashboard.leaderboard[0].completedWeeks, week);
      assert.equal(dashboard.leaderboard[0].cost, advanced.parties[0].cost);
      assert.equal(dashboard.leaderboard[0].finished, week === 24);
      assert.equal(advanced.revealed, week === 24); assert.equal(dashboard.revealed, week === 24);
    }
    await call('beer_game_close', { sessionId: student.sessionId });
    await call('beer_game_close', { sessionId: observer.sessionId });
    {
      // Classroom Group Challenge: a host-only teacher, players creating, joining and switching groups, roles within a group, independent groups, a seat decision for one group, Finish classroom and per-group reveal.
      const fails = async (name, args, pattern) => { const result = await client.callTool({ name, arguments: args }); assert.equal(result.isError, true, name); if (pattern) assert.match(result.content[0].text, pattern); };
      await fails('beer_game_create_chain', { name: 'Groups', kind: 'groups', hostPlays: true }, /hosts only/);
      const teacher = await call('beer_game_create_chain', { name: 'Group MCP', kind: 'groups', visibility: 'dyadic', nickname: 'Teacher', challenge: { seed: 9, method: 'cyclic' } });
      assert.deepEqual([teacher.isObserver, teacher.role, teacher.gameKind, teacher.groups, teacher.room.challenge], [true, null, 'groups', [], { method: 'cyclic', seed: 9 }]);
      await fails('beer_game_create_group', { sessionId: teacher.sessionId, name: 'Staff' }, /Only players/);
      const pupils = [];
      for (const nickname of ['S1', 'S2', 'S3', 'S4']) pupils.push(await call('beer_game_join_chain', { code: teacher.room.code, nickname }));
      assert.deepEqual([pupils[0].role, pupils[0].group], [null, null]);
      let lobby; const lobbyBy = Date.now() + 5000;
      do lobby = await call('beer_game_state', { sessionId: teacher.sessionId }); while (lobby.room.members.filter(m => m.nickname).length < 5 && Date.now() < lobbyBy);
      assert.equal(lobby.lobbySummary, '0 of 4 players ready · waiting for S1, S2, S3 and S4 to join a group');
      await fails('beer_game_change_role', { sessionId: pupils[0].sessionId, role: 'Retailer' }, /Join a group/);
      const red = (await call('beer_game_create_group', { sessionId: pupils[0].sessionId, name: 'Red' })).group;
      assert.equal(red.name, 'Red');
      assert.equal((await call('beer_game_change_role', { sessionId: pupils[0].sessionId, role: 'Retailer' })).role, 'Retailer');
      const joined = await call('beer_game_join_group', { sessionId: pupils[1].sessionId, group: 'red', role: 'Wholesaler' });
      assert.deepEqual([joined.group, joined.role], [red, 'Wholesaler']);
      assert.deepEqual(joined.groups.map(g => [g.id, g.name, g.members.map(m => [m.nickname, m.role]), g.freePlaces, g.isMine]), [[red.id, 'Red', [['S1', 'Retailer'], ['S2', 'Wholesaler']], 2, true]]);
      await fails('beer_game_create_group', { sessionId: pupils[2].sessionId, name: 'RED' }, /A group named RED exists/);
      const blue = (await call('beer_game_create_group', { sessionId: pupils[2].sessionId, name: 'Blue' })).group;
      assert.equal((await call('beer_game_change_role', { sessionId: pupils[2].sessionId, role: 'Retailer' })).role, 'Retailer', 'roles are unique per group');
      await fails('beer_game_join_group', { sessionId: pupils[3].sessionId, group: red.id, role: 'Retailer' }, /Joined Red, but Retailer is taken by S1/);
      const switched = await call('beer_game_join_group', { sessionId: pupils[3].sessionId, group: blue.id, role: 'Distributor' });
      assert.deepEqual([switched.group.name, switched.role, switched.groups.map(g => [g.name, g.members.length])], ['Blue', 'Distributor', [['Red', 2], ['Blue', 2]]]);
      await call('beer_game_wait', { sessionId: teacher.sessionId, timeoutMs: 15000 });
      const review = await call('beer_game_state', { sessionId: teacher.sessionId });
      assert.equal(review.canStart, true);
      assert.deepEqual(review.startReview.find(r => r.label === 'Groups'), { label: 'Groups', value: 'Red: S1 (Retailer), S2 (Wholesaler); Blue: S3 (Retailer), S4 (Distributor)' });
      const watching = await call('beer_game_start', { sessionId: teacher.sessionId });
      assert.deepEqual([watching.phase, watching.canOrder, watching.leaderboard.map(r => [r.nickname, r.members.map(m => m.nickname + ' ' + m.role)])], ['observing', false, [['Blue', ['S3 Retailer', 'S4 Distributor']], ['Red', ['S1 Retailer', 'S2 Wholesaler']]]]);
      for (const pupil of pupils) await call('beer_game_wait', { sessionId: pupil.sessionId, afterWeek: 0, timeoutMs: 15000 });
      await fails('beer_game_join_group', { sessionId: pupils[0].sessionId, group: blue.id }, /before it starts/);
      // Blue plays all 24 weeks while Red waits for its own members only.
      await call('beer_game_order', { sessionId: pupils[0].sessionId, week: 1, amount: 6 });
      let redWaiting; const ackBy = Date.now() + 5000;
      do redWaiting = await call('beer_game_state', { sessionId: pupils[0].sessionId }); while (redWaiting.orderStatus?.state !== 'accepted' && Date.now() < ackBy);
      assert.deepEqual([redWaiting.week, redWaiting.waitingFor, redWaiting.orderStatus.waitingFor], [1, ['Wholesaler'], ['S2']]);
      for (let week = 1; week <= 24; week++) {
        await call('beer_game_order', { sessionId: pupils[2].sessionId, week, amount: 8 });
        await call('beer_game_order', { sessionId: pupils[3].sessionId, week, amount: week % 3 + 6 });
        for (const pupil of pupils.slice(2)) assert.equal((await call('beer_game_wait', { sessionId: pupil.sessionId, afterWeek: week, timeoutMs: 10000 })).week, week + 1);
      }
      assert.equal((await call('beer_game_state', { sessionId: pupils[0].sessionId })).week, 1);
      const blueDone = await call('beer_game_state', { sessionId: pupils[2].sessionId });
      assert.deepEqual([blueDone.phase, blueDone.revealed, blueDone.debrief, blueDone.parties.map(p => p.role)], ['complete', false, null, ['Retailer', 'Wholesaler']]);
      // S2 leaves Red: the teacher lets the system play Wholesaler for Red only, and Red's week advances.
      await call('beer_game_close', { sessionId: pupils[1].sessionId });
      let asked; const askedBy = Date.now() + 5000;
      do asked = await call('beer_game_state', { sessionId: teacher.sessionId }); while (!asked.absentPlayers.some(a => a.state === 'left') && Date.now() < askedBy);
      assert.deepEqual(asked.absentPlayers.map(a => [a.group, a.role, a.state, a.canDecide, a.message]), [[red.id, 'Wholesaler', 'left', true, 'Red: S2 (Wholesaler) has left. Let the system play Wholesaler, or keep waiting?']]);
      const decided = await call('beer_game_decide', { sessionId: teacher.sessionId, role: 'Wholesaler', systemPlays: true, group: 'Red' });
      assert.equal(decided.room.groups.find(g => g.id === red.id).automated.Wholesaler, 'Teacher');
      const redNext = await call('beer_game_wait', { sessionId: pupils[0].sessionId, afterWeek: 1, timeoutMs: 10000 });
      assert.deepEqual([redNext.week, redNext.systemRoles, redNext.absentPlayers.map(a => a.state)], [2, ['Wholesaler', 'Distributor', 'Manufacturer'], ['system']]);
      const live = await call('beer_game_state', { sessionId: teacher.sessionId });
      assert.deepEqual([live.classroomCounts, live.leaderboard.map(r => [r.nickname, r.finished, r.completedWeeks])], [{ playing: 1, disconnected: 0, finished: 1, incomplete: 0 }, [['Blue', true, 24], ['Red', false, 1]]]);
      // Finish classroom: Red stops as incomplete and every member sees only their own group's full chain.
      const finishedGroups = await call('beer_game_finish_classroom', { sessionId: teacher.sessionId });
      assert.deepEqual([finishedGroups.revealed, finishedGroups.leaderboard.map(r => [r.nickname, r.finished, r.incomplete])], [true, [['Blue', true, false], ['Red', false, true]]]);
      const shown = {};
      for (const [i, pupil] of [[0, pupils[0]], [2, pupils[2]], [3, pupils[3]]]) {
        let s; const by = Date.now() + 5000;
        do s = await call('beer_game_state', { sessionId: pupil.sessionId }); while (!s.revealed && Date.now() < by);
        assert.deepEqual([s.revealed, s.phase, s.canOrder, s.parties.length], [true, 'complete', false, 4]);
        shown[i] = { state: s, history: (await call('beer_game_history', { sessionId: pupil.sessionId })).history };
      }
      assert.deepEqual(shown[2].history, shown[3].history, 'one group, one chain');
      assert.equal(shown[0].history.length, 1); assert.equal(shown[2].history.length, 24);
      assert.equal(shown[0].history[0].demand, shown[2].history[0].demand, 'the same seeded customer demand');
      assert.notDeepEqual(shown[0].history[0].parties, shown[2].history[0].parties);
      assert.equal(shown[2].state.debrief.team.totalCost, finishedGroups.leaderboard[0].cost);
      assert.equal(shown[0].state.teamCost, finishedGroups.leaderboard[1].cost);
      await fails('beer_game_order', { sessionId: pupils[0].sessionId, week: 2, amount: 4 });
      for (const pupil of [pupils[0], pupils[2], pupils[3]]) await call('beer_game_close', { sessionId: pupil.sessionId });
      await call('beer_game_close', { sessionId: teacher.sessionId });
    }
  } finally {
    await client.close(); await transport.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(resolve => wss.close(resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
