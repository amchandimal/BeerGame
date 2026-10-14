import { test } from 'node:test';
import assert from 'node:assert/strict';
import { joinCode, lobbyStatus, lobbySummary, startReview, startWithoutPrompt } from './lobby';
import { joinCode as serverJoinCode } from '../../server/index.mjs';
import type { Member, Room } from './multiplayer';

const room = (members: Member[], options: Partial<Room> = {}): Room => ({ kind: 'team', challenge: null, name: 'Lobby', code: '123456', visibility: 'network', host: 'h', started: false, humanRoles: [], members, ...options });
const statuses = (lobby: Room, linked: (id: string) => boolean) => lobby.members.map(m => lobbyStatus(lobby, m, linked));

test('nobody shows Ready before a nickname, a role and an open channel to the creator', () => {
  const lobby = room([
    { id: 'h', nickname: '', role: null },
    { id: 'a', nickname: 'Alex', role: null },
    { id: 'b', nickname: 'Sam', role: 'Distributor' },
    { id: 'c', nickname: 'Kim', role: 'Manufacturer', online: false },
    { id: 'd', nickname: '', role: 'Wholesaler' }
  ]);
  assert.deepEqual(statuses(lobby, () => true), ['Enter nickname', 'Choose role', 'Ready', 'Disconnected — can resume', 'Enter nickname']);
  assert.deepEqual(statuses(lobby, id => id !== 'b'), ['Enter nickname', 'Choose role', 'Connecting', 'Disconnected — can resume', 'Enter nickname']);
  assert.equal(lobbySummary(lobby, 'h', id => id !== 'b'), '0 of 5 players ready · waiting for you and 1 new player to enter a nickname; Alex to choose a role; Sam to connect; Kim to reconnect');
});

test('the summary counts ready players and names each blocker once', () => {
  const lobby = room([{ id: 'h', nickname: 'Host', role: 'Retailer' }, { id: 'a', nickname: 'Alex', role: null }, { id: 'b', nickname: 'Sam', role: 'Distributor' }]);
  assert.equal(lobbySummary(lobby, 'h', () => true), '2 of 3 players ready · waiting for Alex to choose a role');
  assert.equal(lobbySummary(lobby, 'a', () => true), '2 of 3 players ready · waiting for you to choose a role');
  lobby.members[1].role = 'Wholesaler';
  assert.equal(lobbySummary(lobby, 'h', () => true), '3 of 3 players ready');
  lobby.members.push({ id: 'c', nickname: 'Kim', role: null }, { id: 'd', nickname: 'Lee', role: null });
  assert.equal(lobbySummary(lobby, 'h', () => true), '3 of 5 players ready · waiting for Kim and Lee to choose a role');
});

test('a host-only classroom creator is never asked for a role and is not counted as a player', () => {
  const lobby = room([{ id: 'h', nickname: '', role: null }], { kind: 'classroom', hostPlays: false });
  assert.equal(lobbyStatus(lobby, lobby.members[0], () => true), 'Enter nickname');
  assert.equal(lobbySummary(lobby, 'h', () => true), '0 of 0 players ready · waiting for you to enter a nickname; a player to join');
  lobby.members[0].nickname = 'Teacher';
  assert.equal(lobbyStatus(lobby, lobby.members[0], () => true), 'Ready');
  lobby.members.push({ id: 's', nickname: 'Student', role: 'Retailer' });
  assert.equal(lobbySummary(lobby, 'h', () => true), '1 of 1 player ready');
  // A creator who also plays still needs a role.
  const playing = room([{ id: 'h', nickname: 'Teacher', role: null }], { kind: 'classroom', hostPlays: true });
  assert.equal(lobbyStatus(playing, playing.members[0], () => true), 'Choose role');
});

test('the client and server read typed and pasted codes the same way', () => {
  const site = 'beergame.io';
  const cases: [string, string | null][] = [['295384', '295384'], ['295 384', '295384'], ['012-345', '012345'], [' 012.345 ', '012345'], ['01 23 45', '012345'], [`https://${site}/multiplayer/join/012345`, '012345'], [`https://BeerGame.io/multiplayer/join/295384/?from=qr`, '295384'],
    ['12345', null], ['1234567', null], ['12a456', null], ['', null], ['https://elsewhere.example/multiplayer/join/295384', null], [`https://${site}/multiplayer/join/29538`, null]];
  for (const [typed, code] of cases) { assert.equal(joinCode(typed, site), code, typed); assert.equal(serverJoinCode(typed, site), code, typed); }
});

test('the pre-start review names mode, visibility, human and system roles and the classroom scenario; starting without a member says what happens to them', () => {
  const team = room([{ id: 'h', nickname: 'Host', role: 'Retailer' }, { id: 'a', nickname: 'Alex', role: 'Wholesaler', online: false }, { id: 'b', nickname: 'Sam', role: null }], { visibility: 'dyadic' });
  assert.deepEqual(startReview(team), [{ label: 'Mode', value: 'Team Supply Chain' }, { label: 'Visibility', value: 'Dyadic' }, { label: 'Players', value: 'Host (Retailer), Alex (Wholesaler), 1 still choosing' }, { label: 'System plays', value: 'Roles nobody has chosen at start' }]);
  team.members[2].role = 'Manufacturer';
  assert.deepEqual(startReview(team).slice(2), [{ label: 'Players', value: 'Host (Retailer), Alex (Wholesaler), Sam (Manufacturer)' }, { label: 'System plays', value: 'Distributor' }]);
  assert.deepEqual(startWithoutPrompt(team, [team.members[1]]), { label: 'Start without Alex', message: 'Start without Alex? Their role will be played by the system.' });
  assert.deepEqual(startWithoutPrompt(team, [{ id: 'n', nickname: '', role: null }]), { label: 'Start without 1 new player', message: 'Start without 1 new player?' });
  const classroom = room([{ id: 'h', nickname: 'Teacher', role: null }, { id: 's', nickname: 'Ada', role: 'Retailer' }], { kind: 'classroom', hostPlays: false, challenge: { role: 'Retailer', seed: 42, method: 'sma' } });
  assert.deepEqual(startReview(classroom), [{ label: 'Mode', value: 'Classroom Individual Challenge' }, { label: 'Visibility', value: 'Network Wide' }, { label: 'Everyone plays', value: 'Retailer' }, { label: 'Demand', value: 'Simple moving average · seed 42' },
    { label: 'Competitors', value: 'Ada (you host only)' }, { label: 'System plays', value: 'Wholesaler, Distributor, Manufacturer in every run' }]);
  assert.equal(startWithoutPrompt(classroom, [classroom.members[1]]).message, 'Start without Ada? They will not be in this classroom.');
});

test('a group lobby asks each player to join a group, then to choose a role; the review lists groups and those dropped at start; start without keeps a seat only beside a group-mate', () => {
  const lobby = room([{ id: 'h', nickname: 'Teacher', role: null }, { id: 'a', nickname: 'Alex', role: 'Retailer', group: 'g1' }, { id: 'b', nickname: 'Sam', role: null, group: 'g1' }, { id: 'c', nickname: 'Kim', role: null }, { id: 'd', nickname: '', role: null }],
    { kind: 'groups', hostPlays: false, challenge: { seed: 7, method: 'cyclic' }, groups: [{ id: 'g1', name: 'Red' }, { id: 'g2', name: 'Blue' }] });
  assert.deepEqual(statuses(lobby, () => true), ['Ready', 'Ready', 'Choose role', 'Join a group', 'Enter nickname']);
  assert.equal(lobbySummary(lobby, 'h', () => true), '1 of 4 players ready · waiting for 1 new player to enter a nickname; Kim to join a group; Sam to choose a role');
  assert.deepEqual(startReview(lobby), [{ label: 'Mode', value: 'Classroom Group Challenge' }, { label: 'Visibility', value: 'Network Wide' }, { label: 'Demand', value: 'Cyclic demand · seed 7' },
    { label: 'Groups', value: 'Red: Alex (Retailer), Sam (choosing)' }, { label: 'Not in a group', value: 'Kim and 1 new player' }, { label: 'Dropped at start', value: 'Blue (empty)' }, { label: 'System plays', value: 'Roles nobody chose in each group' }]);
  // Start without: Sam keeps the seat beside Alex; Lee, alone in Blue, is removed and Blue is dropped.
  lobby.members[2].role = 'Wholesaler';
  lobby.members.push({ id: 'e', nickname: 'Lee', role: 'Retailer', group: 'g2', online: false });
  assert.equal(startWithoutPrompt(lobby, [lobby.members[2]]).message, 'Start without Sam? Their role will be played by the system.');
  assert.equal(startWithoutPrompt(lobby, [lobby.members[5]]).message, 'Start without Lee? They will not be in this classroom.');
});
