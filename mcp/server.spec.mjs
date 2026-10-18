import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createBeerGameMcp } from './server.mjs';
import { GameSessions } from './sessions.mjs';

test('MCP discovers tools/resources, validates input, routes sessions and reports game errors', async () => {
  const calls = [];
  const sessions = { create: async input => { calls.push(input); return { sessionId: '12345678-1234-4123-8123-123456789012', week: 1 }; },
    command: async (id, input) => { calls.push({ id, ...input }); if (input.type === 'start') throw new Error('Only the creator can start'); return { sessionId: id, week: 2 }; },
    close: async id => ({ sessionId: id, closed: true }) };
  const { server } = createBeerGameMcp(sessions);
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const { tools } = await client.listTools();
    assert.equal(tools.length, 17);
    assert.equal(tools.find(t => t.name === 'beer_game_finish_classroom').annotations.destructiveHint, true);
    assert.equal(tools.find(t => t.name === 'beer_game_state').annotations.readOnlyHint, true);
    assert.equal(tools.find(t => t.name === 'beer_game_close').annotations.destructiveHint, true);
    assert.equal((await client.readResource({ uri: 'beer-game://rules' })).contents.length, 1);
    const created = await client.callTool({ name: 'beer_game_create_single', arguments: { role: 'Retailer' } });
    assert.equal(created.structuredContent.week, 1);
    const id = created.structuredContent.sessionId;
    const invalid = await client.callTool({ name: 'beer_game_order', arguments: { sessionId: id, week: 1, amount: 101 } });
    assert.equal(invalid.isError, true);
    assert.equal(calls.length, 1);
    // Single-player demand: random when omitted, a method and seed to reproduce a game, or standard; anything else is refused before a session starts.
    assert.deepEqual(calls[0], { type: 'single', role: 'Retailer' });
    for (const demand of ['standard', { method: 'cyclic', seed: 4294967295 }]) await client.callTool({ name: 'beer_game_create_single', arguments: { role: 'Wholesaler', demand } });
    assert.deepEqual(calls.splice(1), [{ type: 'single', role: 'Wholesaler', demand: 'standard' }, { type: 'single', role: 'Wholesaler', demand: { method: 'cyclic', seed: 4294967295 } }]);
    for (const demand of ['random', { method: 'ewma', seed: 1 }, { method: 'sma', seed: -1 }, { method: 'wma', seed: 1.5 }, { method: 'sma' }]) assert.equal((await client.callTool({ name: 'beer_game_create_single', arguments: { role: 'Retailer', demand } })).isError, true, JSON.stringify(demand));
    assert.equal(calls.length, 1);
    const order = await client.callTool({ name: 'beer_game_order', arguments: { sessionId: id, week: 1, amount: 4 } });
    assert.equal(order.structuredContent.week, 2);
    assert.deepEqual(calls[1], { id, type: 'order', week: 1, amount: 4 });
    const rejected = await client.callTool({ name: 'beer_game_start', arguments: { sessionId: id } });
    assert.equal(rejected.isError, true);
    assert.match(rejected.content[0].text, /Only the creator/);
    // Classroom Group Challenge tools route to the session with the group and role.
    await client.callTool({ name: 'beer_game_create_group', arguments: { sessionId: id, name: ' Red ' } });
    await client.callTool({ name: 'beer_game_join_group', arguments: { sessionId: id, group: 'g2', role: 'Distributor' } });
    await client.callTool({ name: 'beer_game_decide', arguments: { sessionId: id, role: 'Wholesaler', systemPlays: true, group: 'g1' } });
    assert.deepEqual(calls.slice(-3), [{ id, type: 'createGroup', groupName: 'Red' }, { id, type: 'joinGroup', group: 'g2', role: 'Distributor' }, { id, type: 'decide', role: 'Wholesaler', systemPlays: true, group: 'g1' }]);
    assert.equal((await client.callTool({ name: 'beer_game_create_group', arguments: { sessionId: id, name: 'x'.repeat(25) } })).isError, true);
    assert.equal((await client.callTool({ name: 'beer_game_close', arguments: { sessionId: id } })).structuredContent.closed, true);
  } finally { await client.close(); await server.close(); }
});
test('session configuration rejects invalid destinations and unknown session IDs', async () => {
  assert.throws(() => new GameSessions({ appUrl: 'file:///tmp/game' }), /HTTP/);
  const sessions = new GameSessions();
  assert.throws(() => sessions.get('missing'), /Unknown or closed/);
  await sessions.dispose();
});
