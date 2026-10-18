import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { createSignalingServer } from '../server/index.mjs';

const command = (page, input) => page.evaluate(input => window.beerGameAgent.command(input), input);
const state = page => page.evaluate(() => window.beerGameAgent.state());
const wait = (page, predicate) => page.waitForFunction(predicate, null, { timeout: 15000 });
// This browser's multiplayer saves (one key per room and member), most recent first; `saved` is the latest, or null.
const saves = page => page.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('beer-game.multiplayer.v2.')).map(k => JSON.parse(localStorage.getItem(k))).sort((a, b) => b.savedAt - a.savedAt));
const saved = async page => (await saves(page))[0] ?? null;
// Runs in a page: simulated classroom competitors with real signaling and WebRTC data channels. Each plays its weeks up to `target`; `close` disconnects it.
function startBots({ url, code, count }) {
  window.bots = Array.from({ length: count }, (_, i) => {
    const bot = { name: `Student ${String(i + 1).padStart(2, '0')}`, week: 0, sentWeek: 0, target: 0, channel: null, pc: null, queue: Promise.resolve() };
    const ws = new WebSocket(url);
    bot.play = () => { if (bot.channel?.readyState === 'open' && bot.week && bot.week <= Math.min(bot.target, 24) && bot.sentWeek < bot.week) { bot.sentWeek = bot.week; bot.channel.send(JSON.stringify({ type: 'order', week: bot.week, amount: 4 + i % 5 })); } };
    bot.close = () => { ws.close(); bot.pc?.close(); };
    const handle = async msg => {
      if (msg.type === 'welcome') ws.send(JSON.stringify({ type: 'join', code }));
      else if (msg.type === 'session') ws.send(JSON.stringify({ type: 'nickname', nickname: bot.name }));
      else if (msg.type === 'signal' && msg.signal.description?.type === 'offer') { // A new offer (also after the host reconnects) replaces the connection.
        bot.pc?.close();
        const pc = bot.pc = new RTCPeerConnection();
        pc.onicecandidate = e => { if (e.candidate) ws.send(JSON.stringify({ type: 'signal', to: msg.from, signal: { candidate: e.candidate.toJSON() } })); };
        pc.ondatachannel = e => { bot.channel = e.channel; e.channel.onmessage = m => { const data = JSON.parse(m.data); if (data.type === 'state') { bot.week = data.week; bot.play(); } }; };
        await pc.setRemoteDescription(msg.signal.description);
        await pc.setLocalDescription(await pc.createAnswer());
        ws.send(JSON.stringify({ type: 'signal', to: msg.from, signal: { description: pc.localDescription } }));
      } else if (msg.type === 'signal' && msg.signal.candidate) await bot.pc?.addIceCandidate(msg.signal.candidate).catch(() => {});
    };
    ws.onmessage = e => { const msg = JSON.parse(e.data); bot.queue = bot.queue.then(() => handle(msg)).catch(() => {}); };
    return bot;
  });
}

test('browser refresh resumes team pending orders and observer classroom engines; invitations work on mobile', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [];
  async function page() {
    const context = await browser.newContext();
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#agent'); await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  async function resume(page) {
    await page.goto(origin + '/#agent');
    await page.reload();
    await page.getByRole('button', { name: 'Resume game' }).click();
    await wait(page, () => window.beerGameAgent.state().room !== null);
  }
  try {
    const host = await page(), guest = await page();
    const created = await command(host, { type: 'create', name: 'Refresh team', role: 'Retailer', visibility: 'none', nickname: 'Host' });
    await command(guest, { type: 'join', code: created.room.code, role: 'Wholesaler', nickname: 'Guest' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    assert.equal(created.room.invitationUrl, `${origin}/multiplayer/join/${created.room.code}`);
    await host.locator('.invitation img').waitFor();
    const mobile = await browser.newPage({ viewport: { width: 390, height: 844 } });
    await mobile.goto(created.room.invitationUrl);
    assert.equal(await mobile.locator('#chainCode').inputValue(), created.room.code);
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mobile.getByRole('button', { name: 'Join supply chain' }).click();
    await mobile.locator('#nickname').waitFor();
    assert.equal(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await mobile.screenshot({ path: 'resume-mobile-preview.png', fullPage: true });
    await mobile.getByRole('button', { name: 'Back to modes' }).click();
    await wait(host, () => window.beerGameAgent.state().room.members.length === 2);
    await command(host, { type: 'start' });
    await wait(guest, () => window.beerGameAgent.state().canOrder);
    await command(guest, { type: 'order', week: 1, amount: 7 });
    await wait(host, () => window.beerGameAgent.state().submittedRoles.includes('Wholesaler'));
    const guestSave = await saved(guest);
    assert.equal(guestSave.game, null); assert.deepEqual(guestSave.challengeGames, []); assert.deepEqual(guestSave.pending, {});
    await resume(guest);
    await wait(guest, () => window.beerGameAgent.state().submitted);
    assert.equal((await state(guest)).room.members.find(m => m.nickname === 'Guest').id, guestSave.id);
    await resume(host);
    await wait(host, () => window.beerGameAgent.state().canOrder);
    assert.ok((await state(host)).submittedRoles.includes('Wholesaler'));
    await command(host, { type: 'order', week: 1, amount: 9 });
    await wait(guest, () => window.beerGameAgent.state().week === 2);
    const before = await state(host);
    await resume(host); await wait(host, () => window.beerGameAgent.state().canOrder);
    assert.deepEqual((await state(host)).parties, before.parties);
    assert.deepEqual((await state(host)).lastWeek, before.lastWeek);
    await command(host, { type: 'leave' });
    await wait(guest, () => !window.beerGameAgent.state().room);
    assert.equal(await saved(guest), null);
    await command(guest, { type: 'leave' });

    const classroom = await command(host, { type: 'create', name: 'Observer resume', kind: 'classroom', hostPlays: false, role: 'Retailer', nickname: 'Teacher' });
    await command(guest, { type: 'join', code: classroom.room.code, nickname: 'Student' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    await wait(guest, () => window.beerGameAgent.state().canOrder);
    await command(guest, { type: 'order', week: 1, amount: 6 });
    await wait(guest, () => window.beerGameAgent.state().week === 2);
    const classroomBefore = await state(guest);
    await resume(host);
    await wait(guest, () => window.beerGameAgent.state().canOrder);
    assert.equal((await state(host)).isObserver, true);
    await resume(guest); await wait(guest, () => window.beerGameAgent.state().canOrder);
    assert.deepEqual((await state(guest)).parties, classroomBefore.parties);
    for (let week = 2; week <= 24; week++) {
      await command(guest, { type: 'order', week, amount: 6 });
      await guest.waitForFunction(week => window.beerGameAgent.state().week === week + 1, week);
    }
    await wait(host, () => window.beerGameAgent.state().leaderboard.every(row => row.finished));
    assert.equal(await saved(host), null); assert.equal(await saved(guest), null);

    const ui = await browser.newPage();
    await ui.goto(origin + '/multiplayer/team-supply-chain');
    await ui.locator('#chainName').fill('Start validation');
    await ui.getByRole('button', { name: 'Create supply chain' }).click();
    await ui.getByRole('button', { name: 'Start multiplayer game' }).click();
    assert.match(await ui.getByRole('alert').innerText(), /nickname.*Save nickname/);
    await ui.screenshot({ path: 'resume-lobby-preview.png', fullPage: true });
    await ui.reload();
    await ui.getByRole('button', { name: 'Resume game' }).waitFor();
    await ui.screenshot({ path: 'resume-banner-preview.png', fullPage: true });
    await ui.getByRole('button', { name: 'Resume game' }).click();
    await ui.getByRole('button', { name: 'Start multiplayer game' }).waitFor();
    assert.equal(await ui.locator('h1').innerText(), 'Start validation');
    const blockedStorage = await browser.newPage();
    await blockedStorage.addInitScript(() => { Storage.prototype.setItem = () => { throw new Error('Storage blocked'); }; });
    await blockedStorage.goto(origin + '/multiplayer/team-supply-chain');
    await blockedStorage.locator('#chainName').fill('No storage');
    await blockedStorage.getByRole('button', { name: 'Create supply chain' }).click();
    await blockedStorage.getByRole('status').filter({ hasText: 'storage is unavailable' }).waitFor();
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('navigation keeps sessions, exits confirm their consequence, failed create or join keeps the save, essential hints show on phones', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], phone = { width: 375, height: 812 };
  async function page(viewport, path = '/#agent') {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + path);
    if (path.endsWith('#agent')) await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  // Answers the confirmation an action opens and returns its wording.
  async function reply(page, accept, action) {
    const dialog = page.waitForEvent('dialog'), done = action();
    const opened = await dialog, message = opened.message();
    await (accept ? opened.accept() : opened.dismiss()); await done;
    return message;
  }
  const atWeek = (page, week) => page.locator('.week-row > span', { hasText: `Week ${week} of 24` }).waitFor({ timeout: 5000 });
  try {
    const single = await page(undefined, '/');
    await single.getByRole('link', { name: /Single Player/ }).click();
    await single.getByRole('radio', { name: /Retailer/ }).check();
    await single.getByRole('button', { name: 'Start game' }).click();
    await single.getByRole('button', { name: 'Play this week' }).click();
    await single.getByRole('button', { name: 'Play this week' }).click();
    await atWeek(single, 3);
    await single.goBack();
    await single.getByRole('button', { name: 'Return to game' }).waitFor();
    assert.equal(new URL(single.url()).pathname, '/');
    await single.goForward();
    await atWeek(single, 3);
    await single.locator('.brand').click();
    await single.getByRole('button', { name: 'Return to game' }).click();
    await atWeek(single, 3);
    assert.equal(await reply(single, false, () => single.getByRole('button', { name: 'New game' }).click()), 'Discard your week-3 game?');
    await atWeek(single, 3);
    await single.locator('.brand').click();
    await reply(single, true, () => single.getByRole('button', { name: 'End game' }).click());
    await single.getByRole('link', { name: /Single Player/ }).click();
    await single.getByRole('button', { name: 'Start game' }).waitFor();

    const host = await page(), guest = await page();
    const team = await command(host, { type: 'create', name: 'Navigation team', role: 'Retailer', nickname: 'Host' });
    await command(guest, { type: 'join', code: team.room.code, role: 'Wholesaler', nickname: 'Guest' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    await wait(guest, () => window.beerGameAgent.state().canOrder);
    await guest.locator('.brand').click();
    await guest.getByRole('button', { name: 'Return to game' }).waitFor();
    await command(guest, { type: 'order', week: 1, amount: 5 });
    await command(host, { type: 'order', week: 1, amount: 6 });
    await wait(guest, () => window.beerGameAgent.state().week === 2);
    await guest.getByRole('button', { name: 'Return to game' }).click();
    await atWeek(guest, 2);
    assert.equal(await reply(guest, false, () => guest.getByRole('button', { name: 'New game' }).click()), 'Leave this game? Play pauses until you return or the host lets the system play your role.');
    assert.equal(await reply(host, false, () => host.getByRole('button', { name: 'New game' }).click()), 'End the game for everyone?');
    assert.equal((await state(host)).room.members.length, 2);

    const teacher = await page(phone), student = await page();
    const classroom = await command(teacher, { type: 'create', name: 'Phone classroom', kind: 'classroom', role: 'Retailer', nickname: 'Teacher' });
    await command(student, { type: 'join', code: classroom.room.code, nickname: 'Student' });
    await wait(teacher, () => window.beerGameAgent.state().canStart);
    await command(teacher, { type: 'start' });
    await wait(teacher, () => window.beerGameAgent.state().canOrder);
    for (let week = 1; week <= 24; week++) await command(teacher, { type: 'order', week, amount: 4 });
    await teacher.locator('.completion').waitFor();
    assert.equal(await teacher.getByText('Keep this page open to host the remaining players').isVisible(), true);
    assert.equal(await reply(teacher, false, () => teacher.getByRole('button', { name: 'New game' }).click()), 'Close the classroom? 1 player is still playing.');

    const ui = await page(phone, '/multiplayer/team-supply-chain');
    await ui.locator('#chainName').fill('Saved game');
    await ui.getByRole('button', { name: 'Create supply chain' }).click();
    await ui.locator('.invitation').waitFor();
    assert.equal(await ui.getByText('This localhost link works only on this computer').isVisible(), true);
    const original = await saved(ui);
    await ui.reload();
    await ui.getByRole('button', { name: 'Resume game' }).waitFor();
    assert.equal(await ui.getByText('Resume within 24 hours of disconnecting').isVisible(), true);
    await ui.goto(`${origin}/multiplayer/join/${team.room.code}`);
    await ui.getByRole('button', { name: 'Join supply chain' }).click(); // Joining never replaces a save, so nothing is asked.
    await ui.getByRole('alert').waitFor();
    assert.equal(await ui.getByRole('alert').innerText(), `Game ${team.room.code} has already started. Players in it can resume from the browser they joined with.`);
    assert.deepEqual(await saved(ui), original);
    await ui.getByRole('button', { name: 'Resume game' }).click();
    await ui.locator('.invitation').waitFor();
    assert.equal(await ui.locator('h1').innerText(), 'Saved game');
    assert.equal((await saved(ui)).token, original.token);

    const blocked = await ui.context().newPage();
    await blocked.routeWebSocket('**/signaling', ws => ws.onMessage(() => ws.send(JSON.stringify({ type: 'error', message: 'Room capacity reached. Try again later.' }))));
    await blocked.goto(origin + '/multiplayer/team-supply-chain');
    await blocked.locator('#chainName').fill('Failed create');
    await blocked.getByRole('button', { name: 'Create supply chain' }).click();
    await blocked.getByRole('alert').waitFor();
    assert.equal(await blocked.getByRole('alert').innerText(), 'Room capacity reached. Try again later.');
    await blocked.getByRole('button', { name: 'Back to modes' }).click();
    assert.equal((await saved(blocked)).token, original.token);

    await ui.goto(origin + '/multiplayer/team-supply-chain');
    await ui.locator('#chainName').fill('Replacement');
    await ui.getByRole('button', { name: 'Create supply chain' }).click();
    await ui.locator('.invitation').waitFor();
    assert.deepEqual((await saves(ui)).map(s => s.room.name), ['Replacement', 'Saved game'], 'a new game adds a save beside the old one');
    assert.equal((await saves(ui))[1].token, original.token);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('a Team guest who leaves keeps the seat; the creator, or another player while the creator is offline, lets the system play; the player takes back next week', { timeout: 180000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [];
  async function page(context) {
    const page = await (context ?? await browser.newContext()).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#agent'); await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  async function resume(page) {
    await page.goto(origin + '/#agent'); await page.reload();
    await page.getByRole('button', { name: 'Resume game' }).click();
    await wait(page, () => window.beerGameAgent.state().room !== null);
  }
  const absent = (page, role) => page.evaluate(role => window.beerGameAgent.state().absentPlayers.find(a => a.role === role) ?? null, role);
  const atWeek = (page, week) => page.waitForFunction(week => window.beerGameAgent.state().week === week, week, { timeout: 15000 });
  const lastOrder = async (page, role) => (await state(page)).lastWeek.parties.find(p => p.role === role).order;
  async function uiOrder(page, amount) {
    await page.locator('#order').fill(String(amount));
    await page.getByRole('button', { name: 'Send my order' }).click();
    await wait(page, () => window.beerGameAgent.state().submitted);
  }
  try {
    let host = await page();
    const alex = await page(), sam = await page();
    const team = await command(host, { type: 'create', name: 'Seat team', role: 'Retailer', nickname: 'Host' });
    await command(alex, { type: 'join', code: team.room.code, role: 'Wholesaler', nickname: 'Alex' });
    await command(sam, { type: 'join', code: team.room.code, role: 'Distributor', nickname: 'Sam' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    for (const player of [alex, sam]) await wait(player, () => window.beerGameAgent.state().canOrder);

    // A guest who sent an order and then leaves keeps the seat and save; the creator is asked in the game.
    await command(alex, { type: 'order', week: 1, amount: 7 });
    await command(sam, { type: 'order', week: 1, amount: 6 });
    await wait(host, () => window.beerGameAgent.state().submittedRoles.length === 2);
    const alexSave = await saved(alex);
    await command(alex, { type: 'leave' });
    assert.equal((await saved(alex)).token, alexSave.token);
    const prompt = 'Alex (Wholesaler) has left. Let the system play Wholesaler, or keep waiting?';
    await host.getByText(prompt).waitFor();
    assert.equal((await state(host)).room.members.length, 3);
    await wait(sam, () => window.beerGameAgent.state().absentPlayers.length === 1);
    assert.deepEqual(await absent(sam, 'Wholesaler'), { role: 'Wholesaler', nickname: 'Alex', state: 'left', decidedBy: null, canDecide: false, message: 'Alex (Wholesaler) has left. Waiting for the host to decide.' });
    await uiOrder(host, 5);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await state(host)).week, 1);
    // Choosing system play completes the waiting week without further action and keeps Alex's order.
    await host.getByRole('button', { name: 'Let the system play Wholesaler' }).click();
    await atWeek(host, 2); await atWeek(sam, 2);
    assert.equal(await lastOrder(host, 'Wholesaler'), 7);
    await host.locator('.player-marker', { hasText: 'SYSTEM (ALEX LEFT)' }).waitFor();
    assert.equal((await absent(sam, 'Wholesaler')).message, 'Alex (Wholesaler) left. The system is playing Wholesaler (decided by Host).');
    assert.deepEqual((await saved(host)).room.automated, { Wholesaler: 'Host' });
    // The decision survives a host refresh.
    await resume(host); await wait(host, () => window.beerGameAgent.state().canOrder);
    assert.ok((await state(host)).systemRoles.includes('Wholesaler'));
    await command(host, { type: 'order', week: 2, amount: 5 });
    await command(sam, { type: 'order', week: 2, amount: 6 });
    await atWeek(host, 3);

    // A returning player sees that the system plays this week and takes over from the next one, exactly once.
    await resume(alex);
    await alex.getByText('The system is playing Wholesaler this week. You take over from week 4.').waitFor();
    assert.equal((await state(alex)).canOrder, false);
    assert.equal(await alex.getByRole('button', { name: 'System plays this week' }).isDisabled(), true);
    await assert.rejects(command(alex, { type: 'order', week: 3, amount: 9 }), /You take over from week 4/);
    await wait(host, () => window.beerGameAgent.state().absentPlayers.some(a => a.message === 'Alex is back and takes over Wholesaler from week 4.'));
    await command(host, { type: 'order', week: 3, amount: 5 });
    await command(sam, { type: 'order', week: 3, amount: 6 });
    for (const player of [host, sam, alex]) await atWeek(player, 4);
    await wait(alex, () => window.beerGameAgent.state().canOrder);
    await wait(host, () => window.beerGameAgent.state().canOrder);
    await command(host, { type: 'order', week: 4, amount: 5 });
    await command(sam, { type: 'order', week: 4, amount: 6 });
    await wait(host, () => window.beerGameAgent.state().submittedRoles.length === 2);
    await new Promise(r => setTimeout(r, 500));
    const holding = await state(host);
    assert.equal(holding.week, 4); assert.deepEqual(holding.waitingFor, ['Wholesaler']); assert.deepEqual(holding.absentPlayers, []);
    await command(alex, { type: 'order', week: 4, amount: 11 });
    for (const player of [host, sam, alex]) await atWeek(player, 5);
    assert.equal(await lastOrder(host, 'Wholesaler'), 11);
    assert.equal((await state(host)).completedWeeks, 4);

    // With the creator offline, another player answers; the decision applies when the creator returns.
    await command(host, { type: 'order', week: 5, amount: 5 });
    await command(sam, { type: 'order', week: 5, amount: 6 });
    await wait(host, () => window.beerGameAgent.state().submittedRoles.length === 2);
    const hostContext = host.context();
    await host.close();
    await command(alex, { type: 'leave' });
    await wait(sam, () => window.beerGameAgent.state().absentPlayers.some(a => a.canDecide));
    assert.equal((await absent(sam, 'Wholesaler')).message, `${prompt} The host is offline, so your answer applies when they return.`);
    await sam.getByRole('button', { name: 'Keep waiting' }).waitFor();
    const decided = await command(sam, { type: 'decide', role: 'Wholesaler', systemPlays: true });
    assert.deepEqual(decided.absentPlayers.map(a => [a.state, a.decidedBy, a.message]), [['disconnected', null, 'Host (Retailer) disconnected. Play pauses until they return.'],
      ['system', 'Sam', 'Alex (Wholesaler) left. The system is playing Wholesaler (decided by Sam). Play continues when the host returns.']]);
    assert.equal(decided.week, 5);
    host = await page(hostContext);
    await resume(host);
    await atWeek(host, 6); await atWeek(sam, 6);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await state(host)).completedWeeks, 5);
    assert.equal((await state(host)).absentPlayers[0].decidedBy, 'Sam');

    // Nobody answers: the game waits, and the player can still resume and order.
    await command(sam, { type: 'leave' });
    await host.getByText('Sam (Distributor) has left. Let the system play Distributor, or keep waiting?').waitFor();
    assert.equal(await host.locator('.turn-roles span', { hasText: 'Distributor' }).innerText(), 'Distributor · Left'); // Not "Choosing…" before a decision.
    await uiOrder(host, 5);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await state(host)).week, 6);
    await host.getByRole('button', { name: 'Keep waiting' }).click();
    await host.getByText('Waiting for Sam (Distributor) to return. Host chose to keep waiting.').waitFor();
    assert.equal(await host.getByRole('button', { name: 'Keep waiting' }).count(), 0);
    assert.equal(await host.getByRole('button', { name: 'Let the system play Distributor' }).isVisible(), true);
    assert.equal((await state(host)).week, 6);
    await resume(sam);
    await wait(host, () => !window.beerGameAgent.state().absentPlayers.some(a => a.role === 'Distributor'));
    await wait(sam, () => window.beerGameAgent.state().canOrder);
    await command(sam, { type: 'order', week: 6, amount: 6 });
    await atWeek(host, 7);
    assert.equal(await lastOrder(host, 'Distributor'), 6);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('on a 375×812 phone the weekly order is above the fold, its result shows under submit, and the board follows in DOM order', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], phone = { width: 375, height: 812 };
  async function page(viewport, path = '/#agent') {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + path);
    if (path.endsWith('#agent')) await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  async function onScreen(page, selector) {
    const box = await page.locator(selector).boundingBox();
    assert.ok(box && box.y >= 0 && box.y + box.height <= 812, `${selector} is off-screen at ${JSON.stringify(box)}`);
  }
  async function orderAboveFold(page) {
    await page.evaluate(() => scrollTo(0, 0));
    await onScreen(page, '#order'); await onScreen(page, '.order-submit .primary');
  }
  const sections = page => page.evaluate(() => [...document.querySelectorAll('.turn-card, .week-recap, .multiplayer-turn, .leaderboard, .main-stats, .board-column, details.analytics')].map(e => e.classList[e.classList.length - 1]));
  async function noOverflow(page) {
    for (const width of [320, 375, 390]) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await page.setViewportSize(phone);
  }
  try {
    const single = await page(phone, '/single-player');
    await single.getByRole('radio', { name: /Manufacturer/ }).check();
    await single.getByRole('button', { name: 'Start game' }).click();
    await orderAboveFold(single);
    await single.getByRole('button', { name: 'Play this week' }).click();
    await single.locator('.week-recap', { hasText: 'Week 1 complete' }).waitFor();
    await onScreen(single, '.week-recap');
    await orderAboveFold(single);
    assert.deepEqual(await sections(single), ['turn-card', 'week-recap', 'main-stats', 'board-column', 'analytics']);
    // The board is open by default, can be collapsed, and Watch reopens it and scrolls to it without changing the URL.
    await single.getByRole('button', { name: 'Hide board', expanded: true }).click();
    await single.getByRole('button', { name: 'Show board', expanded: false }).waitFor();
    assert.equal(await single.locator('.scene-board').isVisible(), false);
    await single.getByRole('link', { name: 'Watch week 1' }).click();
    await single.getByRole('button', { name: 'Hide board' }).waitFor();
    await wait(single, () => Math.abs(document.getElementById('supply-board').getBoundingClientRect().top) < 2);
    assert.equal(await single.evaluate(() => location.pathname + location.hash), '/single-player');
    await noOverflow(single);
    // Desktop keeps the board on the left of the turn card, with the phone-only controls hidden.
    await single.setViewportSize({ width: 1280, height: 900 });
    // Both boxes in one evaluation: the Watch link's smooth scroll may still be settling after the resizes.
    const [board, turn] = await single.evaluate(() => ['.board-column', '.turn-card'].map(s => document.querySelector(s).getBoundingClientRect().toJSON()));
    assert.ok(board.x + board.width < turn.x && Math.abs(board.y - turn.y) < 1);
    for (const hidden of ['.watch-board', '.board-toggle', '.visibility-chip']) assert.equal(await single.locator(hidden).isVisible(), false);

    const host = await page(phone), guest = await page();
    const team = await command(host, { type: 'create', name: 'Phone team', role: 'Retailer', nickname: 'Host' });
    const nickname = 'W'.repeat(24);
    await command(guest, { type: 'join', code: team.room.code, role: 'Wholesaler', nickname });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    await wait(host, () => window.beerGameAgent.state().canOrder);
    await orderAboveFold(host);
    assert.deepEqual(await sections(host), ['turn-card', 'multiplayer-turn', 'main-stats', 'board-column', 'analytics']);
    for (const width of [375, 320]) {
      await host.setViewportSize({ width, height: 812 });
      const tops = await host.locator('.turn-roles span').evaluateAll(chips => chips.map(chip => Math.round(chip.getBoundingClientRect().top)));
      assert.equal(tops.length, 4); assert.equal(new Set(tops).size, 2, `team chips use two rows at ${width}px`);
    }
    await host.setViewportSize(phone);
    await host.locator('#order').fill('6');
    await host.getByRole('button', { name: 'Send my order' }).click();
    await command(guest, { type: 'order', week: 1, amount: 5 });
    await host.locator('.week-recap', { hasText: 'Week 1 complete' }).waitFor();
    await onScreen(host, '.week-recap');
    await orderAboveFold(host);
    // A system-played role's station label stays inside its card with a 24-character nickname.
    await command(guest, { type: 'leave' });
    await wait(host, () => window.beerGameAgent.state().absentPlayers.some(a => a.state === 'left'));
    await command(host, { type: 'decide', role: 'Wholesaler', systemPlays: true });
    const label = host.locator('.player-marker', { hasText: 'LEFT' });
    await label.waitFor();
    const fit = await label.evaluate(text => { const card = text.parentElement.querySelector('.station-card').getBBox(), box = text.getBBox(); return { text: text.textContent, inside: box.x + box.width <= card.x + card.width }; });
    assert.deepEqual(fit, { text: 'SYSTEM (WWWWWWWWWWWWW… LEFT)', inside: true });
    await noOverflow(host);

    const teacher = await page(phone), student = await page();
    const classroom = await command(teacher, { type: 'create', name: 'Phone classroom', kind: 'classroom', role: 'Retailer', nickname: 'Teacher' });
    await command(student, { type: 'join', code: classroom.room.code, nickname: 'Student' });
    await wait(teacher, () => window.beerGameAgent.state().canStart);
    await command(teacher, { type: 'start' });
    await wait(teacher, () => window.beerGameAgent.state().canOrder);
    await orderAboveFold(teacher);
    assert.deepEqual(await sections(teacher), ['turn-card', 'leaderboard', 'main-stats', 'board-column', 'analytics']);
    await teacher.getByRole('button', { name: 'Play this week' }).click();
    await teacher.locator('.week-recap', { hasText: 'Week 1 complete' }).waitFor();
    await onScreen(teacher, '.week-recap');
    await noOverflow(teacher);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('lobby readiness names every blocker, feedback sits beside Start and its fields, and Reconnect after a signaling drop keeps identity, orders and the save', { timeout: 180000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [];
  // Signaling goes through a proxy, so the test can drop a page's live connection.
  async function page(path) {
    const page = await (await browser.newContext()).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    const sockets = [];
    await page.routeWebSocket('**/signaling', ws => { ws.connectToServer(); sockets.push(ws); });
    page.drop = () => sockets.at(-1).close({ code: 4000, reason: 'Test drop' });
    await page.goto(origin + path);
    return page;
  }
  const roster = page => page.locator('.lobby-status > ul > li').evaluateAll(items => items.map(li => `${li.querySelector('strong').textContent}: ${li.querySelector('.member-status').textContent}`));
  const summary = page => page.locator('.start-summary').innerText();
  const focused = page => page.evaluate(() => document.activeElement?.id || document.activeElement?.textContent.trim());
  const atWeek = (page, week) => page.locator('.week-row > span', { hasText: `Week ${week} of 24` }).waitFor({ timeout: 15000 });
  async function noOverflow(page) {
    for (const width of [320, 375, 1280]) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
  }
  try {
    // A missing game name is reported beside its field, which receives focus.
    const host = await page('/multiplayer/team-supply-chain');
    await host.getByRole('button', { name: 'Create supply chain' }).click();
    assert.equal(await host.locator('#chainName-error').innerText(), 'Enter a game name.');
    assert.equal(await host.locator('#chainName').getAttribute('aria-describedby'), 'chainName-error');
    assert.equal(await focused(host), 'chainName');
    await host.locator('#chainName').fill('Ready team');
    await host.getByRole('button', { name: 'Create supply chain' }).click();
    await host.locator('.invitation').waitFor();
    const code = await host.locator('.room-code').innerText();
    assert.deepEqual(await roster(host), ['New player: Enter nickname']);
    assert.equal(await summary(host), '0 of 1 player ready · waiting for you to enter a nickname');

    // A failed start is explained beside Start (the only alert on the page) and focuses the missing field.
    await host.getByRole('button', { name: 'Start multiplayer game' }).click();
    assert.match(await host.getByRole('alert').innerText(), /nickname.*Save nickname/);
    assert.equal(await host.locator('.start-area [role=alert]').count(), 1);
    assert.equal(await focused(host), 'nickname');

    const guest = await page(`/multiplayer/join/${code}`);
    await guest.getByRole('button', { name: 'Join supply chain' }).click();
    await guest.locator('#nickname').waitFor();
    await host.locator('.lobby-status > ul > li').nth(1).waitFor();
    assert.deepEqual(await roster(host), ['New player: Enter nickname', 'New player: Enter nickname']);
    assert.equal(await summary(host), '0 of 2 players ready · waiting for you and 1 new player to enter a nickname');
    await host.locator('#nickname').fill('Host');
    await host.getByRole('button', { name: 'Save nickname' }).click();
    await host.locator('.start-summary', { hasText: 'waiting for 1 new player to enter a nickname; you to choose a role' }).waitFor();
    assert.equal(await host.locator('#start-error').innerText(), 'Choose your role before starting.');
    await host.getByRole('button', { name: 'Start multiplayer game' }).click();
    assert.match(await focused(host), /^▤\s*Retailer/);

    // A server-side nickname error is shown beside the nickname field, not in the general area.
    await guest.locator('#nickname').fill('host');
    await guest.getByRole('button', { name: 'Save nickname' }).click();
    await guest.locator('#nickname-error', { hasText: 'That nickname is taken.' }).waitFor();
    assert.equal(await guest.locator('#nickname').getAttribute('aria-describedby'), 'nickname-error');
    assert.equal(await guest.getByRole('alert').count(), 1);
    await wait(guest, () => document.activeElement?.id === 'nickname');
    await guest.locator('#nickname').fill('Alex');
    await guest.getByRole('button', { name: 'Save nickname' }).click();
    await host.locator('.start-summary', { hasText: 'Alex to choose a role' }).waitFor();
    await guest.locator('#nickname-error').waitFor({ state: 'detached' });
    await host.getByRole('button', { name: /Retailer/ }).click();
    await host.locator('.start-summary', { hasText: '1 of 2 players ready' }).waitFor();
    assert.equal(await summary(host), '1 of 2 players ready · waiting for Alex to choose a role');
    assert.equal(await host.locator('.start-review dd').last().innerText(), 'Roles nobody has chosen at start'); // Not listed while Alex is still choosing.
    await guest.getByRole('button', { name: /Wholesaler/ }).click();
    await host.locator('.start-summary', { hasText: '2 of 2 players ready' }).waitFor();
    assert.deepEqual(await roster(host), ['Host: Ready', 'Alex: Ready']);
    assert.equal(await host.locator('.start-review dd').last().innerText(), 'Distributor, Manufacturer');
    assert.equal(await host.locator('#start-error').count(), 0);
    await guest.locator('.start-summary', { hasText: '2 of 2 players ready' }).waitFor();
    assert.deepEqual(await roster(guest), ['Host: Ready', 'Alex: Ready']);
    assert.equal(await guest.locator('.lobby-status p', { hasText: 'Unclaimed roles' }).innerText(), 'Unclaimed roles will be automated at start: Distributor, Manufacturer.');
    await host.locator('.connection-details summary').click();
    assert.match(await host.locator('.connection-details').innerText(), /Alex\s*WebRTC connected/);
    await noOverflow(host);

    // Lobby drop: the roster says the player can resume, and Reconnect rejoins with the same membership and no prompt.
    const guestSave = await saved(guest);
    await guest.drop();
    await host.locator('.member-status', { hasText: 'Disconnected — can resume' }).waitFor();
    assert.equal(await summary(host), '1 of 2 players ready · waiting for Alex to reconnect');
    await guest.getByText('Connection lost. Select Reconnect to rejoin the game.').waitFor();
    assert.deepEqual(await saved(guest), guestSave);
    await guest.getByRole('button', { name: 'Reconnect' }).click();
    await host.locator('.start-summary', { hasText: '2 of 2 players ready' }).waitFor();
    assert.deepEqual([(await saved(guest)).id, (await saved(guest)).token], [guestSave.id, guestSave.token]);

    // In-game guest drop after ordering: Reconnect restores the sent order, which counts exactly once.
    await host.getByRole('button', { name: 'Start multiplayer game' }).click();
    await guest.locator('#order').fill('7');
    await guest.getByRole('button', { name: 'Send my order' }).click();
    await host.locator('.turn-roles span', { hasText: 'Wholesaler · Ready ✓' }).waitFor();
    await guest.drop();
    await guest.locator('.multiplayer-turn').getByRole('button', { name: 'Reconnect' }).waitFor();
    await host.getByText('Alex (Wholesaler) disconnected. Play pauses until they return.').waitFor();
    assert.deepEqual([(await saved(guest)).id, (await saved(guest)).token], [guestSave.id, guestSave.token]);
    await guest.getByRole('button', { name: 'Reconnect' }).click();
    await guest.getByRole('button', { name: 'Order accepted' }).waitFor({ timeout: 15000 });
    assert.equal(await guest.getByRole('button', { name: 'Order accepted' }).isDisabled(), true);
    assert.equal(await host.locator('.turn-roles span', { hasText: 'Ready ✓' }).count(), 1);
    await host.locator('#order').fill('5');
    await host.getByRole('button', { name: 'Send my order' }).click();
    await atWeek(host, 2); await atWeek(guest, 2);
    assert.match(await host.locator('.chain-party', { hasText: 'Wholesaler' }).textContent(), /Last order\s*7/);
    assert.equal(await host.locator('.analytics tbody tr').count(), 1);

    // Host drop while a guest waits: the guest sees the host is offline (C-04); Reconnect restores the host's engine and pending order.
    await guest.locator('#order').fill('9');
    await guest.getByRole('button', { name: 'Send my order' }).click();
    await host.locator('.turn-roles span', { hasText: 'Wholesaler · Ready ✓' }).waitFor();
    const hostSave = await saved(host);
    await host.drop();
    await host.getByText('Connection lost. Select Reconnect to rejoin the game.').waitFor();
    await guest.getByText('Host (Retailer) disconnected. Play pauses until they return.').waitFor();
    assert.equal(await guest.locator('.order-status').innerText(), 'Accepted for week 2: 9 cases. Waiting for the host to return.');
    assert.equal(await host.getByText('Connecting to Alex').count(), 0); // The host is the one offline.
    assert.equal((await saved(host)).token, hostSave.token);
    await noOverflow(host);
    await host.getByRole('button', { name: 'Reconnect' }).click();
    await host.locator('.turn-roles span', { hasText: 'Wholesaler · Ready ✓' }).waitFor({ timeout: 15000 });
    await atWeek(host, 2);
    await guest.locator('.order-status', { hasText: 'Accepted for week 2: 9 cases. Waiting for Host.' }).waitFor();
    await host.locator('#order').fill('5');
    await host.getByRole('button', { name: 'Send my order' }).click();
    await atWeek(host, 3); await atWeek(guest, 3);
    assert.match(await host.locator('.chain-party', { hasText: 'Wholesaler' }).textContent(), /Last order\s*9/);
    assert.equal(await host.locator('.analytics tbody tr').count(), 2);
    assert.equal((await saved(host)).token, hostSave.token);
    assert.deepEqual(dialogs, []); // Reconnect never asks to end the session.
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('the saved-game card shows its check, keeps the save when the check cannot finish, explains removal; quick wins are in place', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], phone = { width: 375, height: 812 };
  async function page(path = '/#agent', viewport) {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + path);
    if (path.endsWith('#agent')) await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  const focused = page => page.evaluate(() => document.activeElement?.id);
  const fontSize = (page, selector) => page.locator(selector).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize));
  try {
    const host = await page();
    const team = await command(host, { type: 'create', name: 'Card game', role: 'Retailer', nickname: 'Host' });
    const player = await page();
    // 'forward' reaches the server; 'fail' closes at once; 'hang' never answers (the check times out after 5 seconds).
    let network = 'forward';
    await player.routeWebSocket('**/signaling', ws => { if (network === 'forward') ws.connectToServer(); else if (network === 'fail') ws.close(); });
    await command(player, { type: 'join', code: team.room.code, role: 'Wholesaler', nickname: 'Card' });
    const before = await saved(player);
    const card = player.getByRole('region', { name: 'Your games' });
    network = 'fail';
    await player.goto(origin + '/'); await player.reload();
    await card.getByText("Couldn't verify.").waitFor();
    assert.deepEqual(await saved(player), before);
    assert.equal(await card.getByRole('button', { name: 'Remove' }).isVisible(), true);
    network = 'hang';
    await player.reload();
    await card.getByText('Checking…').waitFor();
    await card.getByText("Couldn't verify.").waitFor({ timeout: 10000 });
    assert.deepEqual(await saved(player), before);
    network = 'forward';
    await card.getByRole('button', { name: 'Retry' }).click();
    await card.getByText('Available', { exact: true }).waitFor();
    await command(host, { type: 'leave' });
    await player.reload();
    // The ended game stays listed with its reason until dismissed; its save is already gone.
    await card.locator('li', { hasText: `Card game · ${team.room.code}` }).getByText('Ended or expired.').waitFor();
    assert.equal(await saved(player), null);
    assert.equal(await card.getByRole('button', { name: 'Resume game' }).count(), 0);
    await card.getByRole('button', { name: 'OK' }).click();
    await card.waitFor({ state: 'detached' });

    // Titles, the home heading, the guide toggle and local code validation.
    const ui = await page('/', phone);
    assert.equal(await ui.title(), 'Beer Game Online | beergame.io');
    assert.equal(await ui.locator('h1').innerText(), 'Beer Game Online');
    assert.deepEqual(await ui.locator('h1').evaluate(h => [h.getBoundingClientRect().width, h.getBoundingClientRect().height]), [1, 1]);
    const guide = ui.getByRole('button', { name: 'How to play' });
    assert.equal(await guide.getAttribute('aria-expanded'), 'false');
    await guide.click();
    assert.equal(await ui.getByRole('button', { name: 'Close guide' }).getAttribute('aria-expanded'), 'true');
    assert.equal(await ui.evaluate(() => document.body.innerText.includes('↗')), false);
    assert.equal(await ui.locator('.brand-icon').getAttribute('aria-hidden'), 'true');
    await ui.locator('#homeCode').fill('12');
    await ui.getByRole('button', { name: 'Join' }).click();
    assert.equal(await ui.locator('#homeCode-error').innerText(), 'Enter the six-digit code or paste the invitation link.');
    assert.equal(await focused(ui), 'homeCode');
    assert.equal(new URL(ui.url()).pathname, '/');
    await ui.goto(`${origin}/multiplayer/join/000123`);
    assert.equal(await ui.title(), 'Join a Game | beergame.io');
    await ui.locator('#chainCode').fill('12');
    await ui.getByRole('button', { name: 'Join supply chain' }).click();
    assert.equal(await ui.locator('#chainCode-error').innerText(), 'Enter the six-digit code or paste the invitation link.');
    assert.equal(await ui.locator('.room-status').innerText(), 'Not connected');
    await ui.locator('#chainCode').fill(team.room.code === '000123' ? '000124' : '000123');
    await ui.getByRole('button', { name: 'Join supply chain' }).click();
    await ui.locator('#chainCode-error', { hasText: 'No game uses code' }).waitFor();
    assert.equal(await ui.locator('#chainCode').getAttribute('aria-describedby'), 'chainCode-error');
    await wait(ui, () => document.activeElement?.id === 'chainCode');
    assert.equal(await ui.getByRole('alert').count(), 1);

    // Single player: why Start is disabled, order errors beside the field, and the metric deltas.
    const single = await page('/single-player', { width: 1280, height: 900 });
    const start = single.getByRole('button', { name: 'Start game' });
    assert.equal(await start.isDisabled(), true);
    assert.equal(await single.locator('#start-hint').innerText(), 'Choose a role above to start.');
    assert.equal(await start.getAttribute('aria-describedby'), 'start-hint');
    await single.getByRole('radio', { name: /Wholesaler/ }).check(); // Week 1 at the Wholesaler is the same for every demand scenario.
    await single.locator('#start-hint').waitFor({ state: 'detached' });
    await start.click();
    await single.locator('#order').fill('4.5');
    await single.getByRole('button', { name: 'Play this week' }).click();
    assert.equal(await single.locator('#order-error').innerText(), 'Order must be a whole number from 0 to 100.');
    assert.equal(await single.locator('#order').getAttribute('aria-describedby'), 'order-hint order-error');
    assert.equal(await focused(single), 'order');
    await single.locator('#order').fill('4');
    await single.getByRole('button', { name: 'Play this week' }).click();
    await single.locator('.week-recap', { hasText: 'Week 1 complete' }).waitFor();
    const deltas = await single.locator('.metric-change b').evaluateAll(items => items.map(b => [b.textContent, b.className]));
    assert.deepEqual(deltas, [['No change', ''], ['No change', ''], ['This week: $6.00', 'delta-adverse']]);
    await single.getByRole('button', { name: 'Pause animation' }).waitFor();
    // Small supporting text outside the game workspace is at least 12px.
    await single.locator('details.analytics > summary').click();
    for (const selector of ['.trend-axis', '.legend', '.chain-key', '.chain-party p', 'th', '.metric-change b']) assert.ok(await fontSize(single, selector) >= 12, `${selector} is smaller than 12px`);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('hidden information is revealed only after the game: week 24 in single-player and Team, once every Classroom run is over or the creator finishes it; the debrief reconciles and final screens survive the room closing', { timeout: 300000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [], phone = { width: 375, height: 812 }, desktop = { width: 1280, height: 900 };
  const ROLES = ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'];
  const scope = { network: () => ROLES, dyadic: role => ROLES.filter((r, i) => Math.abs(i - ROLES.indexOf(role)) <= 1), none: role => [role] };
  async function page(viewport) {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    await page.goto(origin + '/#agent'); await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  const atWeek = (page, week) => page.waitForFunction(week => window.beerGameAgent.state().week === week, week, { timeout: 15000 });
  // The CSV a button downloads: its suggested name and lines.
  async function download(page, button) {
    const [file] = await Promise.all([page.waitForEvent('download'), button.click()]);
    return { name: file.suggestedFilename(), lines: (await readFile(await file.path(), 'utf8')).split('\n') };
  }
  async function exportCsv(page) {
    const stats = page.locator('details.analytics');
    if (!await stats.evaluate(details => details.open)) await stats.locator('summary').click();
    return download(page, page.getByRole('button', { name: 'Export CSV' }));
  }
  const hiddenStations = page => page.locator('.station-note', { hasText: /^Information hidden$/ }).count();
  const money = value => '$' + value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // The debrief's cost table matches MCP state, which reconciles with the engine's own totals.
  async function checkDebrief(page, weeks) {
    const current = await state(page), d = current.debrief;
    assert.equal(d.weeks, weeks);
    d.roles.forEach((row, i) => { assert.equal(row.holdingCost + row.backlogCost, current.parties[i].cost); assert.equal(row.totalCost, current.parties[i].cost); });
    assert.equal(d.team.holdingCost + d.team.backlogCost, d.team.totalCost);
    assert.equal(d.team.totalCost, current.parties.reduce((sum, p) => sum + p.cost, 0));
    const costRows = await page.locator('.debrief-tables > div:nth-child(2) tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent.trim())));
    assert.deepEqual(costRows.at(-1), ['Team total', money(d.team.holdingCost), money(d.team.backlogCost), money(d.team.totalCost)]);
    d.roles.forEach((row, i) => assert.deepEqual(costRows[i].slice(1), [money(row.holdingCost), money(row.backlogCost), money(row.totalCost)]));
    const swings = await page.locator('.debrief-tables > div:first-child tbody tr').evaluateAll(rows => rows.map(row => row.cells[2].textContent.trim()));
    assert.deepEqual(swings, d.roles.map(row => `${row.peakBacklog} cases`));
    assert.equal(await page.locator('.bullwhip-plot polyline').count(), 5);
    assert.equal(await page.locator('.bullwhip-plot svg > use').count(), 4 * weeks);
    assert.equal(await page.locator('.bullwhip-legend li').count(), 5);
    assert.equal(await page.locator('.debrief-data tbody tr').count(), weeks);
    for (const selector of ['.bullwhip-legend', '.bullwhip-y', '.debrief .trend-axis', '.debrief th', '.debrief td', '.debrief-note', '.debrief-data summary']) {
      assert.ok(await page.locator(selector).first().evaluate(e => parseFloat(getComputedStyle(e).fontSize)) >= 12, `${selector} is smaller than 12px`);
    }
    return current;
  }
  async function noOverflow(page) {
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await page.setViewportSize(phone);
  }
  try {
    // Single-player Dyadic: the Manufacturer stays hidden until week 24 completes.
    const single = await page(phone);
    await command(single, { type: 'single', role: 'Wholesaler', visibility: 'dyadic', demand: 'standard' });
    for (let week = 1; week <= 23; week++) await command(single, { type: 'order', week, amount: week % 4 * 5 });
    assert.equal(await hiddenStations(single), 1);
    assert.equal((await exportCsv(single)).lines.length, 1 + 3 * 23);
    assert.equal(await single.locator('.debrief').count(), 0);
    await command(single, { type: 'order', week: 24, amount: 8 });
    await single.locator('.debrief').waitFor();
    assert.equal(await hiddenStations(single), 0);
    assert.equal(await single.locator('.player-marker', { hasText: 'REVEALED AFTER THE GAME' }).count(), 1);
    assert.equal(await single.locator('.visibility-chip').innerText(), 'Dyadic visibility · revealed after the game');
    assert.match(await single.locator('.week-row strong').innerText(), /^Team cost/);
    const singleCsv = await download(single, single.getByRole('button', { name: 'Download results' }));
    assert.match(singleCsv.name, /^beer-game-standard-wholesaler-\d{4}-\d{2}-\d{2}\.csv$/); assert.equal(singleCsv.lines.length, 97);
    await checkDebrief(single, 24);
    await noOverflow(single);

    // Team at every level: the Manufacturer guest sees only its scope through week 23, then the whole chain.
    for (const level of ['network', 'dyadic', 'none']) {
      const host = await page(desktop), guest = await page(phone);
      const team = await command(host, { type: 'create', name: `Reveal ${level}`, role: 'Retailer', visibility: level, nickname: 'Host' });
      await command(guest, { type: 'join', code: team.room.code, role: 'Manufacturer', nickname: 'Guest' });
      await wait(host, () => window.beerGameAgent.state().canStart);
      await command(host, { type: 'start' });
      await wait(guest, () => window.beerGameAgent.state().canOrder);
      for (let week = 1; week <= 23; week++) {
        await command(host, { type: 'order', week, amount: week % 5 + 5 });
        await command(guest, { type: 'order', week, amount: week % 3 * 6 });
        await atWeek(guest, week + 1); await atWeek(host, week + 1);
      }
      const visible = scope[level]('Manufacturer');
      assert.equal(await hiddenStations(guest), 4 - visible.length);
      assert.equal(await guest.locator('.station-note', { hasText: 'Demand information hidden' }).count(), level === 'network' ? 0 : 1);
      assert.equal((await exportCsv(guest)).lines.length, 1 + visible.length * 23);
      const before = await state(guest);
      assert.equal(before.revealed, false); assert.deepEqual(before.parties.map(p => p.role), visible); assert.equal(before.debrief, null);
      assert.equal(await guest.locator('.revealed-note, .revealed-tag').count(), 0);
      await command(host, { type: 'order', week: 24, amount: 8 });
      await command(guest, { type: 'order', week: 24, amount: 8 });
      await atWeek(guest, 25); await atWeek(host, 25);
      await guest.locator('.debrief').waitFor();
      assert.equal(await hiddenStations(guest), 0);
      assert.equal(await guest.locator('.station-note', { hasText: 'Demand information hidden' }).count(), 0);
      assert.equal(await guest.locator('.player-marker', { hasText: 'REVEALED AFTER THE GAME' }).count(), 4 - visible.length);
      assert.equal(await guest.locator('.chain-party .revealed-tag').count(), 4 - visible.length);
      assert.equal(await guest.locator('.debrief .revealed-tag').count(), level === 'network' ? 0 : 1);
      if (level === 'none') assert.equal(await guest.locator('.visibility-banner .revealed-note').textContent(), 'Revealed after the game: Retailer, Wholesaler, Distributor, customer demand and team cost.');
      const after = await checkDebrief(guest, 24);
      assert.equal(after.revealed, true); assert.deepEqual(after.parties.map(p => p.role), ROLES);
      const hostAfter = await checkDebrief(host, 24);
      assert.deepEqual(hostAfter.debrief, after.debrief); assert.equal(after.teamCost, hostAfter.teamCost);
      const guestCsv = await download(guest, guest.getByRole('button', { name: 'Download results' }));
      assert.match(guestCsv.name, new RegExp(`^beer-game-reveal-${level}-${team.room.code}-manufacturer-\\d{4}-\\d{2}-\\d{2}\\.csv$`));
      assert.equal(guestCsv.lines.join('\n'), (await command(guest, { type: 'export' })).csv);
      assert.equal(guestCsv.lines.length, 97);
      // Phone order: completion, debrief, week result, team status, stats, board. Desktop: the debrief spans both columns above the board.
      assert.deepEqual(await guest.evaluate(() => [...document.querySelectorAll('.game-workspace > *')].map(e => e.classList[0]).filter(c => c !== 'watch-board')), ['completion', 'panel', 'week-recap', 'multiplayer-turn', 'main-stats', 'board-column']);
      const [done, debriefBox, board] = await Promise.all(['.completion', '.debrief', '.board-column'].map(s => host.locator(s).boundingBox()));
      assert.ok(Math.abs(debriefBox.x - done.x) < 1 && Math.abs(debriefBox.width - done.width) < 1 && debriefBox.y > done.y + done.height && board.y > debriefBox.y + debriefBox.height, 'desktop debrief spans the workspace between the completion card and the board');
      assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      if (level === 'none') await host.screenshot({ path: 'reveal-debrief-preview.png', fullPage: true });
      await noOverflow(guest);
      // The creator leaves; the guest keeps the final screen and its debrief.
      await command(host, { type: 'leave' });
      await guest.locator('.completion [role="status"]', { hasText: 'host ended' }).waitFor();
      assert.equal(await guest.locator('.debrief').isVisible(), true);
      assert.equal((await state(guest)).phase, 'complete'); assert.equal(await saved(guest), null);
      await command(guest, { type: 'leave' });
    }

    // Classroom (Dyadic, playing creator): the creator finishes first and still sees only its scope, including after a refresh.
    const teacher = await page(desktop), student = await page(phone);
    const classroom = await command(teacher, { type: 'create', name: 'Reveal class', kind: 'classroom', role: 'Wholesaler', visibility: 'dyadic', nickname: 'Teacher', challenge: { role: 'Wholesaler', seed: 5, method: 'wma' } });
    await command(student, { type: 'join', code: classroom.room.code, nickname: 'Student' });
    await wait(teacher, () => window.beerGameAgent.state().canStart);
    await command(teacher, { type: 'start' });
    await wait(student, () => window.beerGameAgent.state().canOrder);
    for (let week = 1; week <= 24; week++) await command(teacher, { type: 'order', week, amount: week % 4 * 4 });
    await teacher.locator('.completion', { hasText: 'Hidden information is revealed when every player has finished.' }).waitFor();
    assert.equal(await hiddenStations(teacher), 1); assert.equal(await teacher.locator('.debrief').count(), 0);
    assert.equal((await download(teacher, teacher.getByRole('button', { name: 'Download results' }))).lines.length, 1 + 3 * 24);
    assert.ok(await saved(teacher), 'a complete but unrevealed classroom keeps the host checkpoint');
    await teacher.goto(origin + '/#agent'); await teacher.reload();
    await teacher.getByRole('button', { name: 'Resume game' }).click();
    await wait(teacher, () => window.beerGameAgent.state().phase === 'complete');
    const resumed = await state(teacher);
    assert.equal(resumed.revealed, false); assert.equal(resumed.completedWeeks, 24); assert.deepEqual(resumed.parties.map(p => p.role), scope.dyadic('Wholesaler'));
    await wait(student, () => window.beerGameAgent.state().canOrder);
    for (let week = 1; week <= 23; week++) { await command(student, { type: 'order', week, amount: 7 }); await atWeek(student, week + 1); }
    assert.equal((await state(student)).revealed, false); assert.equal((await state(teacher)).revealed, false);
    assert.equal(await hiddenStations(student), 1);
    await command(student, { type: 'order', week: 24, amount: 7 });
    await teacher.locator('.debrief').waitFor(); await student.locator('.debrief').waitFor();
    assert.equal(await hiddenStations(teacher), 0); assert.equal(await hiddenStations(student), 0);
    const [teacherRun, studentRun] = [await checkDebrief(teacher, 24), await checkDebrief(student, 24)];
    assert.notDeepEqual(teacherRun.debrief, studentRun.debrief, 'each player sees only their own run');
    assert.equal(await teacher.getByRole('button', { name: 'Finish classroom' }).count(), 0);
    assert.equal(await saved(teacher), null); assert.equal(await saved(student), null);
    await command(student, { type: 'leave' }); await command(teacher, { type: 'leave' });

    // Classroom (None, host-only creator): Finish classroom stops B's run as incomplete and reveals both runs; final screens survive closing.
    const observer = await page(phone), a = await page(phone), b = await page(phone);
    const finishing = await command(observer, { type: 'create', name: 'Finish class', kind: 'classroom', hostPlays: false, role: 'Retailer', visibility: 'none', nickname: 'Observer' });
    await command(a, { type: 'join', code: finishing.room.code, nickname: 'Ada' });
    await command(b, { type: 'join', code: finishing.room.code, nickname: 'Ben' });
    await wait(observer, () => window.beerGameAgent.state().canStart);
    await command(observer, { type: 'start' });
    await wait(a, () => window.beerGameAgent.state().canOrder); await wait(b, () => window.beerGameAgent.state().canOrder);
    for (let week = 1; week <= 24; week++) { await command(a, { type: 'order', week, amount: week % 5 * 3 }); await atWeek(a, week + 1); }
    for (let week = 1; week <= 10; week++) { await command(b, { type: 'order', week, amount: 9 }); await atWeek(b, week + 1); }
    assert.equal(await hiddenStations(a), 3); assert.equal(await a.locator('.debrief').count(), 0);
    assert.equal((await download(a, a.getByRole('button', { name: 'Download results' }))).lines.length, 25);
    dialogs.length = 0;
    await observer.getByRole('button', { name: 'Finish classroom' }).click();
    assert.deepEqual(dialogs, ['Finish the classroom? 1 unfinished run will stop and be marked incomplete.']);
    await observer.getByText('Classroom finished.').waitFor();
    assert.deepEqual(await observer.locator('.leaderboard tbody tr').evaluateAll(rows => rows.map(row => [row.cells[1].textContent, row.cells[2].textContent])), [['Ada', 'Finished'], ['Ben', 'Incomplete · 10 / 24']]);
    assert.equal(await observer.getByRole('button', { name: 'Finish classroom' }).count(), 0);
    await a.locator('.debrief').waitFor();
    assert.equal(await hiddenStations(a), 0);
    assert.equal((await download(a, a.getByRole('button', { name: 'Download results' }))).lines.length, 97);
    await checkDebrief(a, 24);
    await b.locator('.completion h2', { hasText: 'Classroom finished' }).waitFor();
    assert.equal(await b.locator('.completion p').first().innerText(), 'Your run stopped after week 10. Your cost: ' + money((await state(b)).parties[0].cost));
    assert.equal(await b.locator('.week-row > span').innerText(), 'Stopped after week 10');
    assert.equal(await b.locator('#order').count(), 0); assert.equal(await hiddenStations(b), 0);
    const stoppedRun = await checkDebrief(b, 10);
    assert.equal(stoppedRun.phase, 'complete'); assert.equal(stoppedRun.canOrder, false); assert.equal(stoppedRun.leaderboard.find(r => r.nickname === 'Ben').incomplete, true);
    assert.equal((await download(b, b.getByRole('button', { name: 'Download results' }))).lines.length, 1 + 4 * 10);
    await noOverflow(b);
    dialogs.length = 0;
    await observer.getByRole('button', { name: 'Leave classroom' }).click();
    for (const player of [a, b]) {
      await player.locator('.completion [role="status"]', { hasText: 'host ended' }).waitFor();
      assert.equal(await player.locator('.debrief').isVisible(), true);
    }
    assert.deepEqual(dialogs, [], 'leaving a finished classroom asks nothing');
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('the phone lobby puts joining first; codes can be pasted with spaces or as a link; copy, share and a failed QR keep the invitation usable; each join failure has its next action', { timeout: 180000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], phone = { width: 375, height: 812 }, clipboard = ['clipboard-read', 'clipboard-write'];
  async function page(path, options = {}, init) {
    const context = await browser.newContext({ permissions: clipboard, ...options });
    if (init) await context.addInitScript(init);
    const page = await context.newPage();
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + path);
    if (path.endsWith('#agent')) await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  const top = (page, selector) => page.locator(selector).first().evaluate(e => e.getBoundingClientRect().top + scrollY);
  const pasted = page => page.evaluate(() => navigator.clipboard.readText());
  async function noOverflow(page, widths = [320, 375]) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await page.setViewportSize(phone);
  }
  async function join(page, code) {
    await page.locator('#chainCode').fill(code);
    await page.getByRole('button', { name: 'Join supply chain' }).click();
  }
  try {
    // The host keeps the code, QR and link first; Copy code and Copy invitation link use the clipboard.
    const host = await page('/multiplayer/team-supply-chain', { viewport: { width: 1280, height: 900 } });
    await host.locator('#chainName').fill('Phone lobby');
    await host.getByRole('button', { name: 'Create supply chain' }).click();
    await host.locator('.invitation img').waitFor();
    const code = await host.locator('.room-code').innerText(), link = `${origin}/multiplayer/join/${code}`;
    await host.getByRole('button', { name: 'Copy code' }).click();
    await host.locator('.copy-status', { hasText: 'Code copied ✓' }).waitFor();
    assert.equal(await pasted(host), code);
    await host.getByRole('button', { name: 'Copy invitation link' }).click();
    await host.locator('.copy-status', { hasText: 'Link copied ✓' }).waitFor();
    assert.equal(await pasted(host), link);
    await host.locator('#nickname').fill('Host');
    await host.getByRole('button', { name: 'Save nickname' }).click();
    await host.getByRole('button', { name: /Retailer/ }).click();
    await host.locator('.lobby-roles .role-card.selected', { hasText: 'Your role' }).waitFor();
    assert.ok(await top(host, '.code-panel') < await top(host, '.nickname-form'), 'the host sees the invitation first');
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // A phone guest pastes "295 384"-style text into the home field; it becomes the six-digit code.
    const guest = await page('/', { viewport: phone });
    await guest.evaluate(text => navigator.clipboard.writeText(text), `${code.slice(0, 3)} ${code.slice(3)}`);
    await guest.locator('#homeCode').focus();
    await guest.keyboard.press('Control+V');
    await guest.waitForFunction(code => document.querySelector('#homeCode').value === code, code, { timeout: 5000 });
    await guest.getByRole('button', { name: 'Join' }).click();
    await guest.locator('#nickname').waitFor();
    // Guest order at 375px: nickname, role rows, readiness, then a closed Invite others disclosure.
    const order = [];
    for (const selector of ['.nickname-form', '.lobby-roles', '.lobby-status', '.invite-others']) order.push(await top(guest, selector));
    assert.deepEqual(order, [...order].sort((a, b) => a - b), 'guest lobby order');
    const nickname = await guest.locator('#nickname').boundingBox(), save = await guest.getByRole('button', { name: 'Save nickname' }).boundingBox();
    assert.ok(nickname.y > 0 && save.y + save.height <= 812, 'nickname and Save nickname are in the first screen');
    assert.equal(await guest.locator('.invite-others').evaluate(details => details.open), false);
    assert.equal(await guest.locator('.invitation img').isVisible(), false);
    assert.equal(await guest.getByText('Waiting for the host to start.').isVisible(), true);
    // Compact role rows keep ownership explicit; a taken role stays focusable and does nothing.
    const heights = await guest.locator('.lobby-roles .role-card').evaluateAll(cards => cards.map(card => card.getBoundingClientRect().height));
    assert.ok(heights.length === 4 && heights.every(height => height < 72), `compact role rows: ${heights}`);
    const taken = guest.locator('.lobby-roles .role-card', { hasText: 'Retailer' });
    assert.match(await taken.innerText(), /Taken by Host/);
    assert.deepEqual(await taken.evaluate(button => [button.disabled, button.getAttribute('aria-disabled')]), [false, 'true']);
    await guest.getByRole('button', { name: 'Save nickname' }).focus();
    await guest.keyboard.press('Tab');
    assert.equal(await guest.evaluate(() => document.activeElement.textContent), 'ⓘAbout the roles'); // The roles help sits in the heading.
    await guest.keyboard.press('Tab');
    assert.match(await guest.evaluate(() => document.activeElement.textContent), /Retailer\s*Taken by Host/);
    await guest.keyboard.press('Enter');
    await new Promise(r => setTimeout(r, 300));
    assert.equal(await guest.locator('.lobby-roles .role-card.selected').count(), 0);
    await noOverflow(guest);
    await guest.locator('.invite-others summary').click();
    await guest.locator('.invite-others .invitation img').waitFor();
    assert.equal(await guest.locator('.invite-others .room-code').innerText(), code);
    await noOverflow(guest);
    await host.setViewportSize(phone);
    assert.ok(await top(host, '.code-panel') < await top(host, '.nickname-form'), 'on a phone the host still sees the invitation first');
    await noOverflow(host);

    // On phones the invitation uses the share sheet, falling back to copying the link if sharing fails.
    const shareSheet = () => { window.shared = []; navigator.share = async data => { window.shared.push(data); if (window.failShare) throw new DOMException('Blocked', 'NotAllowedError'); }; };
    const sharer = await page(`/multiplayer/join/${code}`, { viewport: phone, isMobile: true, hasTouch: true }, shareSheet);
    await sharer.getByRole('button', { name: 'Join supply chain' }).click();
    await sharer.locator('.invite-others summary').click();
    await sharer.getByRole('button', { name: 'Share invitation' }).click();
    assert.deepEqual(await sharer.evaluate(() => window.shared), [{ title: 'Join Phone lobby', text: `Join Phone lobby with code ${code}.`, url: link }]);
    await sharer.evaluate(() => { window.failShare = true; });
    await sharer.getByRole('button', { name: 'Share invitation' }).click();
    await sharer.locator('.copy-status', { hasText: 'Link copied ✓' }).waitFor();
    assert.equal(await pasted(sharer), link);

    // Without a QR image the link and code stay visible.
    const noQr = await page(`/multiplayer/join/${code}`, { viewport: phone }, () => { HTMLCanvasElement.prototype.getContext = () => null; });
    await noQr.getByRole('button', { name: 'Join supply chain' }).click();
    await noQr.locator('.invite-others summary').click();
    await noQr.getByText('The QR code is unavailable. Share the link or the code.').waitFor();
    assert.equal(await noQr.locator('.invitation img').count(), 0);
    assert.equal(await noQr.locator('.invite-others .room-code').innerText(), code);
    assert.equal(await noQr.locator('.invitation a').innerText(), link);

    // Join failures: malformed, full, unknown, ended and started each say what to do next.
    const joiner = await page('/multiplayer/join', { viewport: phone });
    await join(joiner, 'abc 123');
    assert.equal(await joiner.locator('#chainCode-error').innerText(), 'Enter the six-digit code or paste the invitation link.');
    assert.equal(await joiner.locator('.room-status').innerText(), 'Not connected');
    await joiner.locator('#chainCode').fill(link);
    await joiner.waitForFunction(code => document.querySelector('#chainCode').value === code, code, { timeout: 5000 });
    await joiner.getByRole('button', { name: 'Join supply chain' }).click();
    await joiner.locator('#chainCode-error', { hasText: 'This lobby is full (4 of 4 players). Create your own game, or ask the host to remove an inactive player.' }).waitFor();
    assert.equal(await joiner.locator('.join-next').getByRole('link', { name: 'Create a game' }).getAttribute('href'), '/multiplayer/create');
    const endedHost = await page('/#agent');
    const ended = await command(endedHost, { type: 'create', name: 'Ended game', role: 'Retailer', nickname: 'Gone' });
    await command(endedHost, { type: 'leave' });
    await join(joiner, ended.room.code);
    await joiner.locator('#chainCode-error', { hasText: `Game ${ended.room.code} has ended. Ask the host for a new code.` }).waitFor();
    assert.equal(await joiner.locator('.join-next a').innerText(), 'Create a game');
    const startedHost = await page('/#agent'), member = await page('/#agent');
    const started = await command(startedHost, { type: 'create', name: 'Started game', role: 'Retailer', nickname: 'Owner' });
    await command(member, { type: 'join', code: started.room.code, role: 'Wholesaler', nickname: 'Member' });
    await wait(startedHost, () => window.beerGameAgent.state().canStart);
    await command(startedHost, { type: 'start' });
    let unused = 0; while ([code, ended.room.code, started.room.code].includes(String(unused).padStart(6, '0'))) unused++;
    const unknown = String(unused).padStart(6, '0');
    await join(joiner, unknown);
    await joiner.locator('#chainCode-error', { hasText: `No game uses code ${unknown}. Check the code with your host.` }).waitFor();
    assert.equal(await joiner.locator('.join-next').count(), 0);
    // The public invitation never offers Resume; only the browser holding that room's save does.
    await join(joiner, started.room.code);
    await joiner.locator('#chainCode-error', { hasText: `Game ${started.room.code} has already started. Players in it can resume from the browser they joined with.` }).waitFor();
    assert.equal(await joiner.locator('.join-next').count(), 0);
    assert.equal(await joiner.getByRole('button', { name: 'Resume game' }).count(), 0);
    await noOverflow(joiner);
    await member.goto(`${origin}/multiplayer/join/${started.room.code}`);
    await member.getByRole('button', { name: 'Join supply chain' }).click();
    const next = member.locator('.join-next', { hasText: 'This browser has your place in this game.' });
    await next.waitFor();
    await next.getByRole('button', { name: 'Resume game' }).click();
    await member.locator('.week-row > span', { hasText: 'Week 1 of 24' }).waitFor({ timeout: 15000 });
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('the host reviews the game before start; players change roles; the host removes or starts without a disconnected member, who is told on return; setup keeps unfinished fields on Back', { timeout: 180000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [], phone = { width: 375, height: 812 }, desktop = { width: 1280, height: 900 };
  // Signaling goes through a proxy, so the test can drop a page's live connection.
  async function page(path, viewport = desktop) {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    const sockets = [];
    await page.routeWebSocket('**/signaling', ws => { ws.connectToServer(); sockets.push(ws); });
    page.drop = () => sockets.at(-1).close({ code: 4000, reason: 'Test drop' });
    await page.goto(origin + path);
    return page;
  }
  const steps = async (page, current) => { await page.locator('.setup-steps [aria-current]', { hasText: current }).waitFor(); return page.locator('.setup-steps li').evaluateAll(items => items.map(li => (li.getAttribute('aria-current') ? '> ' : '') + li.textContent)); };
  const review = page => page.locator('.start-review > div').evaluateAll(rows => rows.map(row => [row.querySelector('dt').textContent, row.querySelector('dd').textContent]));
  async function enter(page, nickname, role) {
    await page.locator('#nickname').fill(nickname);
    await page.getByRole('button', { name: 'Save nickname' }).click();
    if (role) { await page.getByRole('button', { name: new RegExp(role) }).click(); await page.locator('.lobby-roles .role-card.selected', { hasText: role }).waitFor(); }
  }
  try {
    // Setup progress, clearer mode lines, and Back keeps unfinished fields.
    const teacher = await page('/multiplayer/create');
    assert.deepEqual(await steps(teacher, 'Game type'), ['> Game type', 'Settings', 'Invite and start']);
    await teacher.getByText('One shared chain. Each player takes a different role.').waitFor();
    await teacher.getByText('Independent runs of the same role and demand. Lowest cost wins.').waitFor();
    await teacher.getByRole('link', { name: /Classroom Individual Challenge/ }).click();
    assert.deepEqual(await steps(teacher, 'Settings'), ['Game type', '> Settings', 'Invite and start']);
    await teacher.locator('#chainName').fill('Review class');
    await teacher.locator('#seed').fill('7');
    await teacher.getByText('Weighted moving average').click();
    await teacher.getByText('Dyadic').click();
    await teacher.getByRole('button', { name: 'Back', exact: true }).click();
    await teacher.waitForURL(`${origin}/multiplayer/create`);
    await teacher.getByRole('link', { name: /Classroom Individual Challenge/ }).click();
    await teacher.waitForFunction(() => document.querySelector('#chainName')?.value === 'Review class' && document.querySelector('#seed')?.value === '7', null, { timeout: 5000 });
    assert.equal(await teacher.getByRole('radio', { name: /Weighted moving average/ }).isChecked(), true);
    assert.equal(await teacher.getByRole('radio', { name: /Dyadic/ }).isChecked(), true);
    await teacher.getByRole('button', { name: 'Create supply chain' }).click();
    await enter(teacher, 'Teacher');
    assert.deepEqual(await steps(teacher, 'Invite and start'), ['Game type', 'Settings', '> Invite and start']);
    // The classroom review and summary line use readable method names, never sma/wma.
    await teacher.locator('.start-review dd', { hasText: 'Teacher' }).waitFor();
    assert.deepEqual(await review(teacher), [['Mode', 'Classroom Individual Challenge'], ['Visibility', 'Dyadic'], ['Everyone plays', 'Retailer'], ['Demand', 'Weighted moving average · seed 7'], ['Competitors', 'Teacher'], ['System plays', 'Wholesaler, Distributor, Manufacturer in every run']]);
    assert.equal(await teacher.locator('.challenge-summary').innerText(), 'Classroom Individual Challenge · Everyone plays Retailer · Weighted moving average · Seed 7');
    assert.equal(await teacher.evaluate(() => /\b(sma|wma)\b/.test(document.body.innerText)), false);
    await teacher.getByRole('button', { name: 'Back to modes' }).click();

    // Team lobby: the host's review, a guest switching roles, and taken roles that do nothing.
    const host = await page('/multiplayer/team-supply-chain');
    await host.locator('#chainName').fill('Review team');
    await host.getByText('None', { exact: true }).click();
    await host.getByRole('button', { name: 'Create supply chain' }).click();
    const code = await host.locator('.room-code').innerText();
    await enter(host, 'Host', 'Retailer');
    const alex = await page(`/multiplayer/join/${code}`, phone), sam = await page(`/multiplayer/join/${code}`, phone);
    for (const player of [alex, sam]) await player.getByRole('button', { name: 'Join supply chain' }).click();
    await enter(alex, 'Alex', 'Wholesaler');
    await enter(sam, 'Sam', 'Distributor');
    await sam.getByRole('button', { name: /Manufacturer/ }).click();
    await host.locator('.lobby-status li', { hasText: 'Sam · Manufacturer' }).waitFor();
    assert.match(await host.locator('.lobby-roles .role-card', { hasText: 'Distributor' }).innerText(), /Available/);
    assert.match(await sam.locator('.lobby-roles .role-card.selected').innerText(), /Manufacturer\s*Your role/);
    await sam.locator('.lobby-roles .role-card', { hasText: 'Wholesaler' }).click({ force: true });
    await new Promise(r => setTimeout(r, 300));
    assert.match(await sam.locator('.lobby-roles .role-card.selected').innerText(), /Manufacturer/);
    await host.locator('.start-summary', { hasText: '3 of 3 players ready' }).waitFor();
    // Role buttons hold no heading or block elements; only your own role is ticked; card labels are 12px; lobby text has 4.5:1 contrast.
    assert.equal(await host.locator('.lobby-roles button :is(h3, div)').count(), 0);
    assert.deepEqual(await host.locator('.lobby-roles .role-card .radio').allTextContents(), ['✓', '', '', '']);
    assert.equal(await host.locator('.lobby-roles .card-bottom').first().evaluate(e => getComputedStyle(e).fontSize), '12px');
    assert.equal(await alex.locator('.lobby-status p', { hasText: 'Waiting for the host to start.' }).evaluate(e => getComputedStyle(e).color), 'rgb(82, 105, 73)');
    assert.deepEqual(await review(host), [['Mode', 'Team Supply Chain'], ['Visibility', 'None'], ['Players', 'Host (Retailer), Alex (Wholesaler), Sam (Manufacturer)'], ['System plays', 'Distributor']]);
    assert.match(await alex.locator('.lobby-status li', { hasText: 'Host' }).first().innerText(), /· Host/);
    assert.equal(await alex.locator('.start-review').count(), 0);

    // An inactive new player is removed; their page is told why when it reconnects.
    const kim = await page(`/multiplayer/join/${code}`, phone);
    await kim.getByRole('button', { name: 'Join supply chain' }).click();
    await host.locator('.lobby-status > ul > li').nth(3).waitFor();
    kim.drop();
    const away = host.locator('.lobby-away');
    await away.getByText('A new player is disconnected.').waitFor();
    assert.equal(await away.locator('p', { hasText: 'Start without 1 new player?' }).count(), 1);
    await host.setViewportSize(phone);
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await host.setViewportSize({ width: 320, height: 812 });
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await host.setViewportSize(desktop);
    await away.getByRole('button', { name: 'Remove new player' }).click();
    await host.locator('.lobby-status h2', { hasText: 'Participants · 3 / 4' }).waitFor();
    await kim.getByRole('button', { name: 'Reconnect' }).click();
    await kim.getByText('The host removed you from this game before it started. You can join another game.').waitFor();

    // Sam disconnects: Start is blocked, and the host can start without Sam, whose role the system plays.
    sam.drop();
    await away.getByText('Sam (Manufacturer) is disconnected.').waitFor();
    await host.locator('.start-summary', { hasText: '2 of 3 players ready · waiting for Sam to reconnect' }).waitFor();
    assert.equal(await away.locator('p', { hasText: 'Start without' }).innerText(), 'Start without Sam? Their role will be played by the system.');
    await host.getByRole('button', { name: 'Start multiplayer game' }).click();
    assert.equal(await host.locator('#start-error').innerText(), 'Wait for all players to connect or resume their game before starting.');
    assert.equal(await host.locator('.week-row').count(), 0);
    await away.getByRole('button', { name: 'Start without Sam' }).click();
    await host.locator('.week-row > span', { hasText: 'Week 1 of 24' }).waitFor();
    await host.getByText('Sam (Manufacturer) was offline at the start. The system is playing Manufacturer (decided by Host).').waitFor();
    await host.locator('.player-marker', { hasText: 'SYSTEM (SAM OFFLINE)' }).waitFor();
    await host.locator('.turn-roles span', { hasText: 'Manufacturer · Auto' }).waitFor();
    for (const player of [host, alex]) {
      await player.locator('.week-row > span', { hasText: 'Week 1 of 24' }).waitFor({ timeout: 15000 });
      await player.getByRole('button', { name: 'Send my order' }).click();
    }
    await host.locator('.week-row > span', { hasText: 'Week 2 of 24' }).waitFor({ timeout: 15000 });
    // Sam returns and takes the role back from the next week.
    await sam.getByRole('button', { name: 'Reconnect' }).click();
    await sam.getByText('The system is playing Manufacturer this week. You take over from week 3.').waitFor({ timeout: 15000 });
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('the host acknowledges each order: Sending, then accepted for week N while waiting for named players; a lost or delayed reply offers Send again without a second order; an interrupted order goes again after Reconnect', { timeout: 180000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [], phone = { width: 375, height: 812 }, desktop = { width: 1280, height: 900 };
  // Agent pages whose signaling goes through a proxy (drop), and whose data channels can lose the next order or hold every outgoing message until released.
  async function page(viewport = desktop) {
    const page = await (await browser.newContext({ viewport })).newPage();
    page.on('pageerror', e => errors.push(e.message));
    page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.dismiss(); });
    const sockets = [];
    await page.routeWebSocket('**/signaling', ws => { ws.connectToServer(); sockets.push(ws); });
    page.drop = () => sockets.at(-1).close({ code: 4000, reason: 'Test drop' });
    await page.addInitScript(() => {
      const send = RTCDataChannel.prototype.send, net = window.testNet = { dropOrders: 0, held: null };
      RTCDataChannel.prototype.send = function (data) {
        if (net.dropOrders && String(data).includes('"type":"order"')) { net.dropOrders--; return; }
        if (net.held) { net.held.push([this, data]); return; }
        return send.call(this, data);
      };
      net.release = () => { const held = net.held ?? []; net.held = null; for (const [channel, data] of held) if (channel.readyState === 'open') send.call(channel, data); };
    });
    await page.goto(origin + '/#agent'); await wait(page, () => !!window.beerGameAgent);
    return page;
  }
  const atWeek = (page, week) => page.waitForFunction(week => window.beerGameAgent.state().week === week, week, { timeout: 15000 });
  async function send(page, amount) { await page.locator('#order').fill(String(amount)); await page.locator('.order-submit .primary').click(); }
  // The line beside the order button and MCP state say the same thing.
  async function shows(page, expected) {
    await page.locator('.order-status', { hasText: expected.message }).waitFor({ timeout: 15000 });
    const { state: current, message, canRetry } = (await state(page)).orderStatus;
    assert.deepEqual({ state: current, message, canRetry }, expected);
  }
  try {
    const host = await page(), alex = await page(), sam = await page(phone);
    const team = await command(host, { type: 'create', name: 'Ack team', role: 'Retailer', visibility: 'none', nickname: 'Host' });
    await command(alex, { type: 'join', code: team.room.code, role: 'Wholesaler', nickname: 'Alex' });
    await command(sam, { type: 'join', code: team.room.code, role: 'Distributor', nickname: 'Sam' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    for (const player of [alex, sam]) await wait(player, () => window.beerGameAgent.state().canOrder);

    // The host's own order is recorded at once; the line names who the week still waits for, and the field says why it is locked.
    await send(host, 5);
    await shows(host, { state: 'accepted', message: 'Accepted for week 1: 5 cases. Waiting for Alex and Sam.', canRetry: false });
    assert.equal(await host.getByRole('button', { name: 'Order accepted' }).isDisabled(), true);
    assert.equal(await host.locator('#order').inputValue(), '5'); assert.equal(await host.locator('#order').isDisabled(), true);
    assert.equal(await host.locator('#order-hint').innerText(), 'Locked until week 2');

    // Alex's order is lost on the way: Sending, then no reply, then Send again delivers it once.
    await alex.evaluate(() => { window.testNet.dropOrders = 1; });
    await send(alex, 7);
    await alex.getByRole('button', { name: 'Sending…' }).waitFor();
    assert.equal((await state(alex)).orderStatus.state, 'sending'); assert.equal((await state(alex)).canOrder, false);
    assert.equal(await alex.locator('#order-hint').innerText(), 'Locked until confirmed');
    assert.equal(await alex.locator('.turn-roles span', { hasText: 'Wholesaler' }).innerText(), 'Wholesaler · Sending…');
    assert.equal(await host.locator('.turn-roles span', { hasText: 'Wholesaler' }).innerText(), 'Wholesaler · Choosing…');
    await shows(alex, { state: 'unconfirmed', message: 'No reply from the host yet. Send your week 1 order (7 cases) again.', canRetry: true });
    assert.equal(await alex.locator('#order').inputValue(), '7');
    await alex.getByRole('button', { name: 'Send again' }).click();
    await shows(alex, { state: 'accepted', message: 'Accepted for week 1: 7 cases. Waiting for Sam.', canRetry: false });
    await host.locator('.turn-roles span', { hasText: 'Wholesaler · Ready ✓' }).waitFor();
    // Who has submitted is public; under None visibility nobody sees another role's amount.
    assert.deepEqual((await state(alex)).pendingOrders, { Wholesaler: 7 });
    assert.deepEqual((await state(sam)).pendingOrders, {});
    assert.deepEqual((await state(sam)).submittedRoles.sort(), ['Retailer', 'Wholesaler']);

    // Sam's reply is delayed: the host already has the order, Sam sends it again through MCP, and the week advances once.
    await host.evaluate(() => { window.testNet.held = []; });
    await send(sam, 6);
    await atWeek(host, 2);
    await shows(sam, { state: 'unconfirmed', message: 'No reply from the host yet. Send your week 1 order (6 cases) again.', canRetry: true });
    const retried = await command(sam, { type: 'order', week: 1, amount: 6 });
    assert.equal(retried.orderStatus.state, 'sending'); assert.equal(retried.week, 1);
    await new Promise(r => setTimeout(r, 500));
    assert.equal((await state(host)).week, 2); assert.equal((await state(host)).completedWeeks, 1);
    await host.evaluate(() => window.testNet.release());
    for (const player of [alex, sam]) await atWeek(player, 2);
    assert.equal((await state(sam)).orderStatus, null);
    assert.equal((await state(sam)).lastWeek.parties[0].order, 6);
    assert.equal(await sam.getByRole('button', { name: 'Send my order' }).isEnabled(), true);

    // Connection interrupted before the reply: the order is kept and goes again after Reconnect.
    await alex.evaluate(() => { window.testNet.dropOrders = 1; });
    await send(alex, 9);
    await alex.getByRole('button', { name: 'Sending…' }).waitFor();
    await alex.drop();
    await shows(alex, { state: 'interrupted', message: 'Connection interrupted. Your week 2 order (9 cases) is not confirmed yet.', canRetry: false });
    assert.equal(await alex.getByRole('button', { name: 'Not confirmed' }).isDisabled(), true);
    await alex.getByRole('button', { name: 'Reconnect' }).click();
    await shows(alex, { state: 'accepted', message: 'Accepted for week 2: 9 cases. Waiting for Host and Sam.', canRetry: false });
    for (const width of [320, 375]) {
      await sam.setViewportSize({ width, height: 812 });
      assert.equal(await sam.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await send(sam, 6);
    await shows(sam, { state: 'accepted', message: 'Accepted for week 2: 6 cases. Waiting for Host.', canRetry: false });
    await send(host, 5);
    for (const player of [host, alex, sam]) await atWeek(player, 3);
    assert.equal((await state(alex)).lastWeek.parties[0].order, 9);
    assert.equal((await state(host)).completedWeeks, 2);
    await host.locator('.analytics tbody tr').nth(1).waitFor({ state: 'attached' }); // The ledger renders after the state reports week 3.
    assert.equal(await host.locator('.analytics tbody tr').count(), 2);
    assert.equal(await host.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(dialogs, []);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('the classroom leaderboard summarises 32 players and the host connection, finds and filters players, explains the ranking, keeps focus while rows move, and shows cards on phones', { timeout: 300000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [], desktop = { width: 1280, height: 900 };
  try {
    const teacher = await (await browser.newContext({ viewport: desktop })).newPage();
    teacher.on('pageerror', e => errors.push(e.message));
    teacher.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
    const sockets = [];
    await teacher.routeWebSocket('**/signaling', ws => { ws.connectToServer(); sockets.push(ws); });
    await teacher.goto(origin + '/#agent'); await wait(teacher, () => !!window.beerGameAgent);
    const created = await command(teacher, { type: 'create', name: 'Big class', kind: 'classroom', role: 'Retailer', nickname: 'Teacher', visibility: 'none' });
    const crowd = await (await browser.newContext()).newPage();
    await crowd.goto(origin + '/healthz');
    await crowd.evaluate(startBots, { url: origin.replace(/^http/, 'ws') + '/signaling', code: created.room.code, count: 31 });
    await teacher.waitForFunction(() => { const s = window.beerGameAgent.state(); return s.room.members.length === 32 && s.canStart; }, null, { timeout: 60000 });
    await command(teacher, { type: 'start' });
    // Six students finish, three stop after week 5 and disconnect, twenty play part of the game and two have not started.
    const targets = Array.from({ length: 31 }, (_, i) => i < 6 ? 24 : i < 9 ? 5 : i < 29 ? 2 + i % 9 : 0);
    await crowd.evaluate(targets => window.bots.forEach((bot, i) => { bot.target = targets[i]; bot.play(); }), targets);
    await teacher.waitForFunction(total => window.beerGameAgent.state().leaderboard.reduce((sum, r) => sum + r.completedWeeks, 0) === total, targets.reduce((a, b) => a + b, 0), { timeout: 120000 });
    await crowd.evaluate(() => window.bots.slice(6, 9).forEach(bot => bot.close()));
    await teacher.waitForFunction(() => window.beerGameAgent.state().classroomCounts.disconnected === 3, null, { timeout: 30000 });

    const counts = () => teacher.locator('.class-counts li').allInnerTexts();
    const rows = () => teacher.locator('.leaderboard tbody tr').evaluateAll(rows => rows.map(row => [...row.cells].map(cell => cell.textContent)));
    assert.deepEqual(await counts(), ['Playing 23', 'Disconnected 3', 'Finished 6', 'Incomplete 0', 'Your connection: online']);
    assert.deepEqual((await state(teacher)).classroomCounts, { playing: 23, disconnected: 3, finished: 6, incomplete: 0 });
    assert.equal(await teacher.locator('.rank-note').innerText(), 'Unfinished players are ordered by progress; finished players are ranked by cost, then time.');
    const all = await rows();
    assert.equal(all.length, 32);
    assert.deepEqual(all.slice(0, 6).map(row => [row[0], row[2]]), [1, 2, 3, 4, 5, 6].map(rank => [String(rank), 'Finished']));
    assert.ok(all.slice(6).every(row => row[0] === '—'));
    const weeks = all.slice(6).map(row => Number(row[2].match(/(\d+) \/ 24$/)[1]));
    assert.deepEqual(weeks, [...weeks].sort((a, b) => b - a), 'unfinished players follow by progress');

    // Find a player by name, or filter by status; ranks stay those of the whole class.
    await teacher.locator('#find-player').fill('student 07');
    await teacher.locator('.filter-count', { hasText: 'Showing 1 of 32 players.' }).waitFor();
    assert.deepEqual((await rows()).map(row => [row[1], row[2]]), [['Student 07', 'Disconnected · 5 / 24']]);
    await teacher.locator('#find-player').fill('');
    await teacher.locator('#status-filter').selectOption('disconnected');
    await teacher.locator('.filter-count', { hasText: 'Showing 3 of 32 players.' }).waitFor();
    assert.deepEqual((await rows()).map(row => row[2]), Array(3).fill('Disconnected · 5 / 24'));
    await teacher.locator('#status-filter').selectOption('finished');
    await teacher.locator('.filter-count', { hasText: 'Showing 6 of 32 players.' }).waitFor();
    assert.deepEqual((await rows()).map(row => row[0]), ['1', '2', '3', '4', '5', '6']);
    await teacher.locator('#status-filter').selectOption('');
    assert.equal(await teacher.locator('.filter-count').innerText(), '');

    // Rows move as players progress; keyboard focus stays in the search box.
    await teacher.locator('#find-player').focus();
    const before = (await rows()).map(row => row[1]);
    await crowd.evaluate(() => window.bots.slice(29).forEach(bot => { bot.target = 20; bot.play(); }));
    await teacher.waitForFunction(() => window.beerGameAgent.state().leaderboard.filter(r => r.completedWeeks === 20).length >= 2, null, { timeout: 60000 });
    assert.notDeepEqual((await rows()).map(row => row[1]), before);
    assert.equal(await teacher.evaluate(() => document.activeElement?.id), 'find-player');

    // Phones get compact cards with the name and progress on one line; no horizontal scrolling at 320 or 375px.
    await teacher.setViewportSize({ width: 375, height: 812 });
    assert.equal(await teacher.locator('.leaderboard .table-wrap').isVisible(), false);
    const cards = teacher.locator('.result-cards li');
    assert.equal(await cards.count(), 32);
    assert.match(await cards.first().innerText(), /^1\. Student \d\d\nFinished\nCost \$[\d,.]+ · Time \d+:\d\d$/);
    assert.ok((await cards.evaluateAll(items => items.map(li => Math.abs(li.querySelector('strong').getBoundingClientRect().top - li.querySelector('span').getBoundingClientRect().top)))).every(gap => gap < 4));
    for (const width of [320, 375]) {
      await teacher.setViewportSize({ width, height: 812 });
      assert.equal(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await teacher.setViewportSize(desktop);
    assert.equal(await cards.first().isVisible(), false); assert.equal(await teacher.locator('.leaderboard table').isVisible(), true);
    assert.equal(await teacher.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

    // The host's own connection: lost after a signaling drop, online again after Reconnect.
    await sockets.at(-1).close({ code: 4000, reason: 'Test drop' });
    await teacher.locator('.host-link.lost', { hasText: 'Your connection: lost' }).waitFor();
    await teacher.getByRole('button', { name: 'Reconnect' }).click();
    await teacher.locator('.host-link:not(.lost)', { hasText: 'Your connection: online' }).waitFor({ timeout: 15000 });
    assert.equal(await teacher.locator('.leaderboard tbody tr').count(), 32);

    // Finish classroom: every unfinished run is incomplete.
    await teacher.getByRole('button', { name: 'Finish classroom' }).click();
    await teacher.waitForFunction(() => window.beerGameAgent.state().classroomCounts.incomplete === 26, null, { timeout: 15000 });
    assert.deepEqual(await counts(), ['Playing 0', 'Disconnected 0', 'Finished 6', 'Incomplete 26', 'Your connection: online']);
    assert.deepEqual(dialogs, ['Finish the classroom? 26 unfinished runs will stop and be marked incomplete.']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

test('accessibility: a skip link, heading focus after route changes, the role radio group, one live announcement per week, week labels on the order and board, readable small text, 44px touch targets and a trend chart with a value axis and non-colour series', { timeout: 120000 }, async () => {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const errors = [], dialogs = [], desktop = { width: 1280, height: 900 };
  const page = await (await browser.newContext({ viewport: desktop })).newPage();
  page.on('pageerror', e => errors.push(e.message));
  page.on('dialog', dialog => { dialogs.push(dialog.message()); void dialog.accept(); });
  const focused = () => page.evaluate(() => `${document.activeElement?.tagName} ${document.activeElement?.textContent.trim()}`);
  const play = async week => { await page.getByRole('button', { name: 'Play this week' }).click(); await page.locator('.week-row > span', { hasText: `Week ${week + 1} of 24` }).waitFor(); };
  try {
    await page.goto(origin + '/');
    // The skip link is the first Tab stop, shows when focused and moves focus to the main content without changing the URL.
    await page.keyboard.press('Tab');
    assert.equal(await focused(), 'A Skip to main content');
    assert.ok((await page.locator('.skip-link').boundingBox()).y >= 0);
    await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'main');
    assert.equal(await page.evaluate(() => location.pathname + location.hash), '/');
    // After a route change, focus starts at the new view's heading.
    await page.getByRole('link', { name: /Single Player/ }).click();
    await wait(page, () => document.activeElement?.tagName === 'H1');
    assert.equal(await focused(), 'H1 Single Player');

    // The single-player role choice is a radio group, like the visibility cards; no button holds a heading or block element.
    const roles = page.getByRole('group', { name: 'Choose your role' });
    assert.equal(await roles.getByRole('radio').count(), 4);
    assert.equal(await page.locator('button :is(h2, h3, div)').count(), 0);
    await roles.getByRole('radio', { name: /Retailer/ }).check();
    await page.keyboard.press('ArrowRight');
    assert.equal(await roles.getByRole('radio', { name: /Wholesaler/ }).isChecked(), true);
    assert.match(await page.locator('.role-card.selected').innerText(), /Wholesaler/);
    assert.equal(await page.locator('.role-card .card-bottom').first().evaluate(e => getComputedStyle(e).fontSize), '12px');
    await page.getByRole('button', { name: 'Start game' }).click();

    // The order is for the upcoming week; the board shows the completed one.
    assert.equal(await page.locator('label[for=order]').innerText(), 'Order for week 1');
    assert.equal(await page.locator('.scene-week').innerText(), 'Starting position');
    // One live region with one concise announcement per week; the demand card, recap and board caption are not live.
    assert.equal(await page.locator('main :is([aria-live], [role=status], [role=alert], [role=log])').count(), 1);
    assert.equal(await page.locator('.week-status').innerText(), 'Week 1 demand: 4 cases.');
    await page.emulateMedia({ reducedMotion: 'reduce' }); // The board caption then completes at once.
    await page.evaluate(() => {
      window.announced = [];
      new MutationObserver(records => { for (const record of records) {
        const region = (record.target.nodeType === 3 ? record.target.parentElement : record.target)?.closest('[aria-live], [role=status], [role=alert], [role=log]'), text = region?.textContent.trim();
        if (text && window.announced.at(-1) !== text) window.announced.push(text);
      } }).observe(document.querySelector('main'), { subtree: true, childList: true, characterData: true });
    });
    await page.locator('#order').fill('6');
    await play(1);
    await page.locator('.scene-caption', { hasText: 'Week 1 complete' }).waitFor();
    const demand = await page.locator('.demand-value > strong').innerText();
    assert.deepEqual(await page.evaluate(() => window.announced), [`Week 1 complete. Week 2 demand: ${demand}.`]);
    assert.equal(await page.locator('label[for=order]').innerText(), 'Order for week 2');
    assert.equal(await page.locator('.scene-week').innerText(), 'Showing completed week 1');
    // Measured small text: the desktop comparison label is 12px and the board's lead labels reach 4.5:1.
    assert.equal(await page.locator('.metric-change small').first().evaluate(e => getComputedStyle(e).fontSize), '12px');
    assert.equal(await page.locator('.lead-label').first().evaluate(e => getComputedStyle(e).fill), 'rgb(115, 95, 48)');

    // Game stats: the trend chart has a value axis in cases, aligned with its gridlines, and series that differ by dash and marker as well as colour.
    await play(2); await play(3);
    await page.locator('details.analytics > summary').click();
    const chart = page.locator('.trend-chart');
    const [top, middle, bottom] = await chart.locator('.trend-y span').allInnerTexts();
    assert.match(top, /^\d+ cases$/); assert.equal(Number(middle) * 2, parseInt(top)); assert.equal(bottom, '0');
    const offsets = await page.evaluate(() => { const svg = document.querySelector('.trend-chart svg').getBoundingClientRect(); return [...document.querySelectorAll('.trend-y span')].map((label, i) => { const r = label.getBoundingClientRect(); return Math.abs(r.top + r.height / 2 - (svg.top + [8, 90, 172][i] / 180 * svg.height)); }); });
    assert.ok(offsets.every(offset => offset < 3), `value labels off their gridlines: ${offsets}`);
    assert.deepEqual(await chart.locator('polyline').evaluateAll(lines => lines.map(line => line.getAttribute('stroke-dasharray'))), [null, '8 4', '2 3']);
    assert.deepEqual(await chart.locator('use').evaluateAll(marks => [...new Set(marks.map(mark => mark.getAttribute('href')))]), ['#tr-circle', '#tr-square', '#tr-triangle']);
    assert.equal(await chart.locator('use').count(), 9);
    assert.ok((await chart.locator('use').first().boundingBox()).width >= 8);
    assert.deepEqual(await page.locator('.trend .legend li').allInnerTexts(), ['Inventory', 'Backlog', 'Orders']);
    assert.equal(await page.locator('.trend .legend li use').count(), 3);
    await page.getByRole('heading', { name: 'Weekly ledger · Wholesaler' }).waitFor();
    assert.equal(await page.locator('.analytics tbody tr').count(), 3);

    // On phones, controls are at least 44px tall, and nothing scrolls sideways at 320 or 375px.
    await page.setViewportSize({ width: 375, height: 812 });
    const small = await page.evaluate(() => [...document.querySelectorAll('button, a, summary, input, select')].flatMap(e => {
      const r = e.getBoundingClientRect();
      return r.width && r.height && r.bottom > 0 && getComputedStyle(e).visibility !== 'hidden' && r.height < 44 ? [`${(e.textContent.trim() || e.id).slice(0, 30)}: ${Math.round(r.height)}px`] : [];
    }));
    assert.deepEqual(small, []);
    for (const width of [320, 375]) {
      await page.setViewportSize({ width, height: 812 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `horizontal overflow at ${width}px`);
    }
    await page.setViewportSize(desktop);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    // Ending the game returns to the home screen with focus on its heading.
    await page.getByRole('button', { name: 'New game' }).click();
    await wait(page, () => document.activeElement?.tagName === 'H1');
    assert.equal(await focused(), 'H1 Beer Game Online');
    assert.deepEqual(dialogs, ['Discard your week-4 game?']);
    assert.deepEqual(errors, []);
  } finally {
    await browser.close();
    for (const socket of wss.clients) socket.terminate();
    await new Promise(r => wss.close(r)); await new Promise(r => server.close(r));
  }
});

// Shared setup for the saved-game tests: a signaling server, a browser, page error and dialog capture.
async function savesHarness() {
  const { server, wss } = createSignalingServer();
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, ...(process.env.BEER_GAME_BROWSER_CHANNEL ? { channel: process.env.BEER_GAME_BROWSER_CHANNEL } : {}) });
  const h = { origin, browser, errors: [], dialogs: [], accept: true };
  h.watch = page => { page.on('pageerror', e => h.errors.push(e.message)); page.on('dialog', d => { h.dialogs.push(d.message()); void (h.accept ? d.accept() : d.dismiss()); }); return page; };
  h.agent = async context => { const page = h.watch(await context.newPage()); await page.goto(origin + '/#agent'); await wait(page, () => !!window.beerGameAgent); return page; };
  h.drop = async page => { await page.goto(origin + '/#agent'); await page.reload(); }; // Like a refresh: the session ends without leaving, so its save stays.
  h.list = page => page.getByRole('region', { name: 'Your games' });
  h.row = (page, name) => h.list(page).locator('li', { hasText: name });
  h.noOverflow = async page => { for (const width of [320, 375]) { await page.setViewportSize({ width, height: 812 }); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `no horizontal overflow at ${width}px`); } };
  h.close = async () => { await browser.close(); for (const socket of wss.clients) socket.terminate(); await new Promise(r => wss.close(r)); await new Promise(r => server.close(r)); };
  return h;
}

test('Your games lists every multiplayer save with its own state; a game open in another tab is not offered; joining or creating adds a save; storage keeps at most five', { timeout: 180000 }, async () => {
  const h = await savesHarness(), { origin, browser } = h;
  try {
    const others = await browser.newContext(), mine = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const alphaHost = await h.agent(others), betaHost = await h.agent(others);
    const alpha = (await command(alphaHost, { type: 'create', name: 'Alpha', role: 'Retailer', nickname: 'Ann' })).room;
    const beta = (await command(betaHost, { type: 'create', name: 'Beta', role: 'Retailer', nickname: 'Bo' })).room;
    // This browser joins Alpha, refreshes, then joins Beta from its invitation link: no save is replaced, so nothing is asked.
    const tab1 = await h.agent(mine);
    await command(tab1, { type: 'join', code: alpha.code, role: 'Wholesaler', nickname: 'Me' });
    await h.drop(tab1);
    await h.row(tab1, 'Alpha').getByText('Available', { exact: true }).waitFor();
    await tab1.goto(`${origin}/multiplayer/join/${beta.code}`);
    await tab1.getByRole('button', { name: 'Join supply chain' }).click();
    await tab1.locator('#nickname').waitFor();
    assert.deepEqual((await saves(tab1)).map(s => s.room.name), ['Beta', 'Alpha']);
    assert.deepEqual(h.dialogs, []);

    // A second tab lists both. Beta is open in tab 1, so it offers nothing until tab 1 closes.
    const tab2 = h.watch(await mine.newPage());
    await tab2.goto(origin + '/');
    await h.row(tab2, 'Beta').getByText('Open in another tab').waitFor();
    await h.row(tab2, 'Alpha').getByText('Available', { exact: true }).waitFor();
    assert.equal(await h.row(tab2, 'Beta').getByRole('button').count(), 0);
    assert.equal(await h.row(tab2, 'Alpha').locator('.saved-name').innerText(), `Alpha · ${alpha.code} · Team · Player`);
    assert.deepEqual(await h.row(tab2, 'Alpha').getByRole('button').evaluateAll(b => b.map(e => e.textContent.trim())), ['Resume game →', 'Remove'], 'a player save has no End game for everyone');
    assert.equal(await h.list(tab2).getByText('This browser keeps up to 5 multiplayer games.').count(), 1);
    await tab1.close();
    await h.row(tab2, 'Beta').getByRole('button', { name: 'Resume game' }).waitFor({ timeout: 5000 });

    // A check that cannot finish affects only that game; Retry asks again.
    let failAlpha = true;
    await tab2.routeWebSocket('**/signaling', ws => { const server = ws.connectToServer(); ws.onMessage(message => { if (failAlpha && JSON.parse(message).code === alpha.code) ws.close(); else server.send(message); }); });
    await tab2.reload();
    await h.row(tab2, 'Alpha').getByText("Couldn't verify.").waitFor();
    await h.row(tab2, 'Beta').getByText('Available', { exact: true }).waitFor();
    failAlpha = false;
    await h.row(tab2, 'Alpha').getByRole('button', { name: 'Retry' }).click();
    await h.row(tab2, 'Alpha').getByText('Available', { exact: true }).waitFor();
    // Alpha's host ends it: the row gives the reason and the save is gone; Beta is untouched.
    await command(alphaHost, { type: 'leave' });
    await tab2.reload();
    await h.row(tab2, 'Alpha').getByText('Ended or expired.').waitFor();
    assert.deepEqual(await h.row(tab2, 'Alpha').getByRole('button').evaluateAll(b => b.map(e => e.textContent.trim())), ['OK']);
    assert.deepEqual((await saves(tab2)).map(s => s.room.name), ['Beta']);

    // Tab 2 creates Gamma; Beta stays saved. Tab 3 sees Gamma open in tab 2 and removes Beta, which asks nothing for a player.
    await tab2.goto(origin + '/multiplayer/team-supply-chain');
    await tab2.locator('#chainName').fill('Gamma');
    await tab2.getByRole('button', { name: 'Create supply chain' }).click();
    await tab2.locator('.invitation').waitFor();
    assert.deepEqual((await saves(tab2)).map(s => s.room.name), ['Gamma', 'Beta']);
    const tab3 = h.watch(await mine.newPage());
    await tab3.goto(origin + '/');
    await h.row(tab3, 'Gamma').getByText('Open in another tab').waitFor();
    await h.row(tab3, 'Beta').getByRole('button', { name: 'Remove' }).click();
    await h.row(tab3, 'Beta').waitFor({ state: 'detached' });
    assert.deepEqual((await saves(tab3)).map(s => s.room.name), ['Gamma']);
    assert.deepEqual(h.dialogs, []);

    // Five more games: the sixth save replaces the oldest one that no other tab has open (Game 1), never Gamma.
    const tab4 = await h.agent(mine);
    for (let i = 1; i <= 5; i++) { await command(tab4, { type: 'create', name: `Game ${i}`, role: 'Retailer', nickname: 'Me' }); await h.drop(tab4); }
    assert.deepEqual((await saves(tab4)).map(s => s.room.name).sort(), ['Game 2', 'Game 3', 'Game 4', 'Game 5', 'Gamma']);
    await tab3.reload();
    await h.row(tab3, 'Game 5').getByText('Available', { exact: true }).waitFor();
    assert.equal(await h.list(tab3).locator('li').count(), 5);
    assert.equal(await tab3.evaluate(() => Object.keys(localStorage).filter(k => k.startsWith('beer-game.')).length), 5);
    // The list fits phones and desktop; the home screen otherwise keeps the mode cards and Join by code.
    assert.equal(await tab3.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(await tab3.evaluate(() => [...document.querySelectorAll('main > :not(.visually-hidden)')].map(e => e.classList[0])), ['panel', 'mode-grid', 'panel']);
    if (process.env.BEER_GAME_SCREENSHOTS) await tab3.screenshot({ path: process.env.BEER_GAME_SCREENSHOTS + '/your-games-1280.png', fullPage: true });
    await h.noOverflow(tab3);
    if (process.env.BEER_GAME_SCREENSHOTS) await tab3.screenshot({ path: process.env.BEER_GAME_SCREENSHOTS + '/your-games-375.png', fullPage: true });
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('a saved host game can be ended for everyone, and removing it warns that its players wait; a player who missed the reveal receives the results on return', { timeout: 240000 }, async () => {
  const h = await savesHarness(), { browser } = h;
  const ROLES = ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'];
  try {
    // Team: the host's tab drops mid-game. From Your games the host ends the game, and the guest is told at once.
    const host = await h.agent(await browser.newContext()), guest = await h.agent(await browser.newContext());
    const team = (await command(host, { type: 'create', name: 'Ending team', role: 'Retailer', nickname: 'Host' })).room;
    await command(guest, { type: 'join', code: team.code, role: 'Wholesaler', nickname: 'Guest' });
    await wait(host, () => window.beerGameAgent.state().canStart);
    await command(host, { type: 'start' });
    await wait(guest, () => window.beerGameAgent.state().canOrder);
    await command(guest, { type: 'order', week: 1, amount: 5 });
    await h.drop(host);
    const row = h.row(host, 'Ending team');
    await row.getByText('Available', { exact: true }).waitFor();
    assert.equal(await row.locator('.saved-name').innerText(), `Ending team · ${team.code} · Team · Host`);
    h.accept = false;
    await row.getByRole('button', { name: 'Remove' }).click();
    assert.deepEqual(h.dialogs, ['Remove Ending team without ending it? Its players wait until it expires in 24 hours.']);
    assert.ok(await saved(host), 'declining keeps the save');
    h.accept = true;
    await row.getByRole('button', { name: 'End game for everyone' }).click();
    await row.getByText('Ended for everyone.').waitFor();
    assert.equal(h.dialogs[1], `End Ending team · ${team.code} for everyone?`);
    assert.equal(await saved(host), null);
    await wait(guest, () => !window.beerGameAgent.state().room);
    assert.equal((await state(guest)).error, 'The host ended the supply chain or its reconnect window expired.');
    assert.equal(await saved(guest), null);
    await row.getByRole('button', { name: 'OK' }).click();
    await h.list(host).waitFor({ state: 'detached' });

    // Classroom (Dyadic): the student finishes first and closes the page; the teacher finishes while the student is away.
    const teacher = await h.agent(await browser.newContext()), student = await h.agent(await browser.newContext({ viewport: { width: 375, height: 812 } }));
    const classroom = (await command(teacher, { type: 'create', name: 'Late reveal', kind: 'classroom', role: 'Wholesaler', visibility: 'dyadic', nickname: 'Teacher', challenge: { role: 'Wholesaler', seed: 9, method: 'sma' } })).room;
    await command(student, { type: 'join', code: classroom.code, nickname: 'Student' });
    await wait(teacher, () => window.beerGameAgent.state().canStart);
    await command(teacher, { type: 'start' });
    await wait(student, () => window.beerGameAgent.state().canOrder);
    for (let week = 1; week <= 24; week++) { await command(student, { type: 'order', week, amount: 6 }); await student.waitForFunction(week => window.beerGameAgent.state().completedWeeks === week, week); }
    assert.equal((await state(student)).revealed, false);
    assert.ok(await saved(student), 'a finished but unrevealed run keeps its save');
    await h.drop(student);
    for (let week = 1; week <= 24; week++) await command(teacher, { type: 'order', week, amount: 4 });
    await wait(teacher, () => window.beerGameAgent.state().revealed);
    // The room is finished, but it still admits the student while the teacher is online.
    await student.reload();
    const late = h.row(student, 'Late reveal');
    await late.getByText('Available', { exact: true }).waitFor();
    await late.getByRole('button', { name: 'Resume game' }).click();
    await student.locator('.debrief').waitFor();
    const after = await state(student);
    assert.deepEqual([after.phase, after.revealed, after.completedWeeks], ['complete', true, 24]);
    assert.deepEqual(after.parties.map(p => p.role), ROLES);
    assert.deepEqual(after.revealedRoles, ['Manufacturer']);
    assert.equal(await saved(student), null, 'the reveal clears the save');
    await h.noOverflow(student);
    // The teacher leaves; the student keeps the results.
    await command(teacher, { type: 'leave' });
    await student.locator('.completion [role="status"]', { hasText: 'host ended' }).waitFor();
    assert.equal(await student.locator('.debrief').isVisible(), true);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('an unfinished single-player game survives a refresh and keeps New game confirmation; another tab is offered it only once the first tab closes; finishing or discarding it removes the save', { timeout: 180000 }, async () => {
  const h = await savesHarness(), { origin, browser } = h;
  const single = page => page.evaluate(() => JSON.parse(localStorage.getItem('beer-game.single.v1')));
  const week = page => page.locator('.week-row > span').innerText();
  // Plays the current week and waits for the next one (or the end).
  const play = async (page, amount) => {
    const before = await week(page);
    await page.locator('#order').fill(String(amount));
    await page.getByRole('button', { name: 'Play this week' }).click();
    await page.waitForFunction(text => document.querySelector('.week-row > span')?.textContent !== text, before);
  };
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    const tab1 = h.watch(await context.newPage());
    await tab1.goto(origin + '/single-player');
    await tab1.getByRole('radio', { name: /^Dyadic/ }).check();
    await tab1.getByRole('radio', { name: /Distributor/ }).check();
    await tab1.getByRole('button', { name: 'Start game' }).click();
    for (const amount of [5, 9, 7]) await play(tab1, amount);
    const cost = await tab1.locator('.week-row strong').innerText(), ledger = (await single(tab1)).game.history;
    assert.equal(await week(tab1), 'Week 4 of 24');
    assert.equal((await single(tab1)).visibility, 'dyadic');
    // A refresh returns to the same week, visibility and costs, without any extra step.
    await tab1.reload();
    await tab1.locator('.week-row > span', { hasText: 'Week 4 of 24' }).waitFor();
    assert.equal(await tab1.locator('.week-row strong').innerText(), cost);
    assert.equal(await tab1.locator('.visibility-chip').innerText(), 'Dyadic visibility · 3 of 4 roles visible');
    assert.deepEqual((await single(tab1)).game.history, ledger);
    assert.equal(await h.list(tab1).count(), 0);
    h.accept = false;
    await tab1.getByRole('button', { name: 'New game' }).click();
    assert.deepEqual(h.dialogs, ['Discard your week-4 game?']);
    assert.equal(await week(tab1), 'Week 4 of 24');
    // On another route the game waits behind the Game in progress bar, also after a refresh there.
    await tab1.locator('.brand').click();
    await tab1.getByRole('button', { name: 'Return to game' }).waitFor();
    await tab1.reload();
    await tab1.getByRole('button', { name: 'Return to game' }).waitFor();
    assert.equal(await h.row(tab1, 'Single player').count(), 0, 'this tab does not offer its own game');

    // A second tab sees the game, but cannot open it while tab 1 has it.
    const tab2 = h.watch(await context.newPage());
    await tab2.goto(origin + '/');
    const row = h.row(tab2, 'Single player');
    await row.getByText('Open in another tab').waitFor();
    assert.equal(await row.locator('.saved-name').innerText(), 'Single player · Distributor · Week 4 of 24');
    assert.equal(await row.getByRole('button').count(), 0);
    assert.equal(await h.list(tab2).locator('.hint').count(), 0, 'the multiplayer hint needs a multiplayer save');
    await tab1.close();
    await row.getByRole('button', { name: 'Resume game' }).waitFor({ timeout: 5000 });
    await h.noOverflow(tab2);
    await row.getByRole('button', { name: 'Remove' }).click();
    assert.deepEqual(h.dialogs, ['Discard your week-4 game?', 'Discard your week-4 game?']);
    assert.ok(await single(tab2), 'declining keeps the save');
    h.accept = true;
    await row.getByRole('button', { name: 'Resume game' }).click();
    await tab2.locator('.week-row > span', { hasText: 'Week 4 of 24' }).waitFor();
    assert.equal(new URL(tab2.url()).pathname, '/single-player');
    assert.equal(await tab2.locator('.week-row strong').innerText(), cost);
    // A finished game is not kept: after a refresh the setup screen shows, with nothing listed.
    while (await week(tab2) !== '24 weeks completed') await play(tab2, 8);
    assert.equal(await single(tab2), null);
    await tab2.reload();
    await tab2.getByRole('button', { name: 'Start game' }).waitFor();
    assert.equal(await h.list(tab2).count(), 0);
    // Discarding through New game removes the save too.
    await tab2.getByRole('radio', { name: /Retailer/ }).check();
    await tab2.getByRole('button', { name: 'Start game' }).click();
    await play(tab2, 4);
    assert.equal((await single(tab2)).game.week, 2);
    await tab2.getByRole('button', { name: 'New game' }).click();
    await tab2.getByRole('link', { name: /Single Player/ }).waitFor();
    assert.equal(await single(tab2), null);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Single Player demand follows a random seeded pattern each game, stays the same after a refresh and is named only once the game is over, on phones without overflow', { timeout: 180000 }, async () => {
  const h = await savesHarness(), { origin, browser } = h;
  const single = page => page.evaluate(() => JSON.parse(localStorage.getItem('beer-game.single.v1')));
  const week = page => page.locator('.week-row > span').innerText();
  const play = async (page, amount) => {
    const before = await week(page);
    await page.locator('#order').fill(String(amount));
    await page.getByRole('button', { name: 'Play this week' }).click();
    await page.waitForFunction(text => document.querySelector('.week-row > span')?.textContent !== text, before);
  };
  const demandCard = page => page.locator('.demand-value > strong').innerText();
  try {
    const context = await browser.newContext({ viewport: { width: 375, height: 812 } });
    // Stubbed 32-bit draws (method, then seed), counted across refreshes: game 1 is wma seed 123456789, game 2 cyclic seed 987654321.
    await context.addInitScript(draws => {
      const real = crypto.getRandomValues.bind(crypto);
      crypto.getRandomValues = array => {
        if (!(array instanceof Uint32Array) || array.length !== 1) return real(array);
        const next = Number(sessionStorage.getItem('test.draws')) || 0;
        sessionStorage.setItem('test.draws', String(next + 1));
        array[0] = draws[next % draws.length]; return array;
      };
    }, [1, 123456789, 2, 987654321]);
    const page = h.watch(await context.newPage());
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto(origin + '/single-player');
    assert.equal(await page.locator('.setup-heading .hint').innerText(), 'Customer demand follows a randomly chosen pattern each game.');
    await h.noOverflow(page);
    await page.getByRole('radio', { name: /Retailer/ }).check();
    await page.getByRole('button', { name: 'Start game' }).click();
    const first = await single(page);
    assert.deepEqual(first.demand, { method: 'wma', seed: 123456789 });
    assert.equal(first.game.customer.length, 24);
    assert.equal(first.game.scenario, undefined);
    assert.equal(await demandCard(page), `${first.game.customer[0]} cases`);
    for (const amount of [4, 6]) await play(page, amount);
    // A refresh at week 3 continues with the same customer demand.
    assert.equal(await week(page), 'Week 3 of 24');
    assert.equal(await demandCard(page), `${first.game.customer[2]} cases`);
    await page.reload();
    await page.locator('.week-row > span', { hasText: 'Week 3 of 24' }).waitFor();
    assert.equal(await demandCard(page), `${first.game.customer[2]} cases`);
    assert.deepEqual([(await single(page)).demand, (await single(page)).game.customer], [first.demand, first.game.customer]);
    // During play nothing names the pattern or seed, and an export says only single-player.
    assert.doesNotMatch(await page.locator('main').innerText(), /seed|moving average|cyclic|123456789/i);
    await page.locator('details.analytics > summary').click();
    const [early] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Export CSV' }).click()]);
    assert.match(early.suggestedFilename(), /^beer-game-single-player-retailer-\d{4}-\d{2}-\d{2}\.csv$/);
    await page.locator('details.analytics > summary').click();
    while (await week(page) !== '24 weeks completed') {
      assert.equal(await demandCard(page), `${first.game.customer[(await single(page)).game.week - 1]} cases`);
      await play(page, 8);
    }
    // The completion card, the debrief and the CSV name the scenario; the CSV has its customer demand.
    assert.equal(await page.locator('.completion .scenario').innerText(), 'Demand: Weighted moving average · seed 123456789');
    assert.equal(await page.locator('.debrief .debrief-note').first().innerText(), 'Demand: Weighted moving average · seed 123456789');
    const [file] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Download results' }).click()]);
    assert.match(file.suggestedFilename(), /^beer-game-wma-seed-123456789-retailer-\d{4}-\d{2}-\d{2}\.csv$/);
    const rows = (await readFile(await file.path(), 'utf8')).split('\n').slice(1).map(line => line.split(','));
    assert.deepEqual(rows.filter(r => r[2] === 'Retailer').map(r => Number(r[1])), first.game.customer);
    await h.noOverflow(page);
    // A new game draws a different pattern and seed. A Dyadic Distributor, with the Retailer out of view, still sees no customer demand.
    await page.getByRole('button', { name: 'New game' }).click();
    await page.getByRole('link', { name: /Single Player/ }).click();
    await page.getByRole('radio', { name: /^Dyadic/ }).check();
    await page.getByRole('radio', { name: /Distributor/ }).check();
    await page.getByRole('button', { name: 'Start game' }).click();
    const second = await single(page);
    assert.deepEqual(second.demand, { method: 'cyclic', seed: 987654321 });
    assert.notDeepEqual(second.game.customer, first.game.customer);
    await play(page, 5);
    assert.equal(await page.locator('.station-note', { hasText: 'Demand information hidden' }).count(), 1);
    assert.equal(await page.locator('.completion').count(), 0);
    assert.doesNotMatch(await page.locator('main').innerText(), /seed|moving average|cyclic|987654321/i);
    assert.deepEqual(h.dialogs, []);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('on-demand help: ⓘ disclosures for the roles, demand, weekly costs, backlog and in transit start closed, explain rules only and fit phones', { timeout: 120000 }, async () => {
  const h = await savesHarness(), { origin, browser } = h;
  try {
    const page = h.watch(await (await browser.newContext({ viewport: { width: 375, height: 812 } })).newPage());
    const info = name => page.getByRole('button', { name });
    // Toggles a disclosure and waits until it renders the new state.
    const toggle = async (name, expanded) => { await info(name).click(); await page.waitForFunction(([n, e]) => [...document.querySelectorAll('.info')].some(b => b.textContent.includes(n) && b.getAttribute('aria-expanded') === e), [name, String(expanded)]); };
    const open = async name => { const button = info(name); return [await button.getAttribute('aria-expanded'), await page.locator('#' + await button.getAttribute('aria-controls')).isVisible()]; };
    await page.goto(origin + '/single-player');
    assert.deepEqual(await open('About the roles'), ['false', false]);
    await toggle('About the roles', true);
    assert.deepEqual(await open('About the roles'), ['true', true]);
    assert.deepEqual(await page.locator('#help-roles li').allInnerTexts(), ['Retailer: Sells to customers and orders from the Wholesaler.', 'Wholesaler: Supplies the Retailer and orders from the Distributor.', 'Distributor: Supplies the Wholesaler and orders from the Manufacturer.', 'Manufacturer: Supplies the Distributor and brews the beer, which takes two weeks.']);
    assert.equal(await page.getByRole('group', { name: 'Choose your role' }).getByRole('radio').count(), 4, 'the help sits outside the radio group name');
    await toggle('About the roles', false);
    assert.deepEqual(await open('About the roles'), ['false', false]);

    // A Wholesaler at None visibility: each explanation is about this role's own numbers and the common rules.
    await page.getByRole('radio', { name: /^None/ }).check();
    await page.getByRole('radio', { name: /Wholesaler/ }).check();
    await page.getByRole('button', { name: 'Start game' }).click();
    await page.getByRole('button', { name: 'Play this week' }).click();
    await page.locator('.week-row > span', { hasText: 'Week 2 of 24' }).waitFor();
    const helps = {
      'About your role': 'Supplies the Retailer and orders from the Distributor.',
      "About this week's demand": "The Retailer's order that reaches you this week. Backlog, the cases you still owe from earlier weeks, comes on top of it.",
      'About weekly costs': 'Charged at the end of each week: $0.50 per case in stock and $1.00 per case of backlog. Shown for the last completed week.',
      'About backlog': 'Cases ordered from you that you could not ship yet. They ship first when stock arrives, and each costs $1.00 a week until then.',
      'About in transit': 'Shipments on their way from the Distributor. Delivery takes two weeks; each line shows the week the cases arrive.'
    };
    for (const name of Object.keys(helps)) assert.deepEqual(await open(name), ['false', false], `${name} starts closed`);
    for (const [name, text] of Object.entries(helps)) {
      await toggle(name, true);
      assert.deepEqual(await open(name), ['true', true]);
      assert.equal(await page.locator('#' + await info(name).getAttribute('aria-controls')).innerText(), text);
      assert.equal(await page.locator('.info-text:visible').count(), 1, 'one explanation at a time');
      const box = await info(name).boundingBox();
      assert.ok(box.width >= 44 && box.height >= 44, `${name} is a 44px target on phones`);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    assert.equal(await page.locator('.info-text').evaluateAll(els => els.filter(e => e.closest('[role="status"], [aria-live]')).length), 0, 'explanations are not live regions');
    await h.noOverflow(page);
    await toggle('About in transit', false);
    assert.equal(await page.locator('.info-text:visible').count(), 0);
    // How to play points to the buttons.
    await page.getByRole('button', { name: 'How to play' }).click();
    await page.getByText('beside a role or value for a short explanation.').waitFor();
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});

test('Classroom Group Challenge: a host-only teacher and two groups of two; groups are created, joined and switched, roles chosen within each group; groups advance on their own; the host and a student resume after a refresh; the leaderboard ranks groups; Finish classroom reveals each group only its own chain; the phone lobby fits', { timeout: 300000 }, async () => {
  const h = await savesHarness(), { browser, origin } = h, desktop = { width: 1280, height: 900 };
  const rows = page => page.locator('.leaderboard tbody tr').evaluateAll(trs => trs.map(tr => [...tr.cells].map(td => td.textContent.trim())));
  const play = async (pair, amounts) => {
    const week = (await state(pair[0])).week;
    for (const [i, page] of pair.entries()) { await wait(page, () => window.beerGameAgent.state().canOrder); await command(page, { type: 'order', week, amount: amounts[i] }); }
    for (const page of pair) await page.waitForFunction(week => window.beerGameAgent.state().completedWeeks >= week, week, { timeout: 15000 });
  };
  try {
    // The teacher creates the game from the kind screen; there is no participation choice.
    const teacher = h.watch(await (await browser.newContext({ viewport: desktop })).newPage());
    await teacher.goto(origin + '/multiplayer/create');
    assert.deepEqual(await teacher.locator('.kind-grid .mode-card h2').allInnerTexts(), ['Team Supply Chain', 'Classroom Individual Challenge', 'Classroom Group Challenge']);
    await teacher.getByRole('link', { name: /Classroom Group Challenge/ }).click();
    await teacher.waitForURL('**/multiplayer/classroom-group-challenge');
    assert.equal(await teacher.title(), 'Classroom Group Challenge | beergame.io');
    assert.equal(await teacher.locator('input[name="hostPlays"]').count(), 0); assert.equal(await teacher.locator('#challengeRole').count(), 0);
    await teacher.locator('#chainName').fill('Group class');
    await teacher.locator('#seed').fill('7');
    await teacher.getByRole('radio', { name: /Dyadic/ }).check();
    await teacher.getByRole('button', { name: 'Create supply chain' }).click();
    await teacher.locator('#nickname').fill('Teacher'); await teacher.getByRole('button', { name: 'Save nickname' }).click();
    const code = (await teacher.locator('.room-code').innerText()).replace(/\D/g, '');
    assert.equal(await teacher.locator('.challenge-summary').innerText(), 'Classroom Group Challenge · Groups of up to 4 · Simple moving average · Seed 7');
    await teacher.locator('.lobby-groups', { hasText: 'No groups yet. Players create them after they join.' }).waitFor();

    // Four students; Ada is on a phone.
    const ada = await h.agent(await browser.newContext({ viewport: { width: 375, height: 812 } }));
    const [ben, cy, dee] = await Promise.all([1, 2, 3].map(async () => h.agent(await browser.newContext({ viewport: desktop }))));
    for (const [page, nickname] of [[ada, 'Ada'], [ben, 'Ben'], [cy, 'Cy'], [dee, 'Dee']]) await command(page, { type: 'join', code, nickname });
    await teacher.locator('.start-summary', { hasText: '0 of 4 players ready · waiting for Ada, Ben, Cy and Dee to join a group' }).waitFor();
    // The phone lobby puts the nickname first, then the groups with Create a group, then the participants; nothing scrolls sideways.
    assert.equal(await ada.evaluate(() => { const [a, b, c] = ['.nickname-form', '.lobby-groups', '.lobby-status'].map(s => document.querySelector(s)); return !!(a.compareDocumentPosition(b) & 4) && !!(b.compareDocumentPosition(c) & 4); }), true);
    const field = await ada.locator('#groupName').boundingBox(), label = await ada.locator('.group-form label').boundingBox();
    assert.ok(field.width > 160 && field.y >= label.y + label.height - 1, 'on phones the group name field sits below its label');
    await ada.locator('#groupName').fill('Red'); await ada.getByRole('button', { name: 'Create group' }).click();
    await ada.locator('.group-list li.mine h3', { hasText: 'Red · Your group' }).waitFor();
    await ada.locator('.group-list li.mine .role-card', { hasText: 'Retailer' }).click();
    await ada.locator('.group-list li.mine .role-card.selected', { hasText: 'Retailer' }).waitFor();
    assert.ok((await ada.locator('.group-list li.mine .role-card').evaluateAll(cards => cards.map(c => c.getBoundingClientRect().height))).every(height => height >= 44));
    await h.noOverflow(ada);
    await ada.setViewportSize({ width: 320, height: 812 });
    assert.ok((await ada.locator('.group-list li.mine .role-card').evaluateAll(cards => cards.map(c => c.scrollWidth - c.clientWidth))).every(spill => spill <= 1), 'role rows fit inside the group card at 320px');
    await ada.setViewportSize({ width: 375, height: 812 });

    await ben.getByRole('button', { name: 'Join Red' }).click();
    await ben.locator('.group-list li.mine .role-card.taken', { hasText: 'Taken by Ada' }).waitFor();
    await ben.locator('.group-list li.mine .role-card', { hasText: 'Wholesaler' }).click();
    // A group name is unique in the room, whatever its case; the error sits beside the field, which keeps focus.
    await cy.locator('#groupName').fill('red'); await cy.getByRole('button', { name: 'Create group' }).click();
    await cy.locator('#groupName-error', { hasText: 'That group name is taken.' }).waitFor();
    assert.equal(await cy.locator('#groupName').getAttribute('aria-describedby'), 'groupName-error');
    await cy.waitForFunction(() => document.activeElement?.id === 'groupName');
    await cy.locator('#groupName').fill('Blue'); await cy.getByRole('button', { name: 'Create group' }).click();
    await cy.locator('.group-list li.mine h3', { hasText: 'Blue · Your group' }).waitFor();
    assert.equal(await cy.locator('#groupName').inputValue(), '');
    await cy.locator('.group-list li.mine .role-card', { hasText: 'Retailer' }).click();
    // Dee joins Red as its Distributor, then switches to Blue, which frees the Distributor seat in Red.
    await dee.getByRole('button', { name: 'Join Red' }).click();
    await dee.locator('.group-list li.mine .role-card', { hasText: 'Distributor' }).click();
    await ben.locator('.group-list li.mine .role-card.taken', { hasText: 'Taken by Dee' }).waitFor();
    await dee.getByRole('button', { name: 'Switch to Blue' }).click();
    await dee.locator('.group-list li.mine h3', { hasText: 'Blue · Your group' }).waitFor();
    assert.equal((await state(dee)).role, null);
    await ben.locator('.group-list li.mine .role-card:not(.taken)', { hasText: 'Distributor' }).waitFor();
    await dee.locator('.group-list li.mine .role-card', { hasText: 'Wholesaler' }).click();
    await wait(dee, () => window.beerGameAgent.state().role === 'Wholesaler');
    assert.equal(await dee.locator('.lobby-status p', { hasText: 'Unclaimed roles in your group will be automated at start:' }).innerText(), 'Unclaimed roles in your group will be automated at start: Distributor, Manufacturer.');

    // The teacher sees both groups, the review and a ready lobby, then starts.
    await teacher.locator('.start-summary', { hasText: '4 of 4 players ready' }).waitFor();
    assert.deepEqual(await teacher.locator('.lobby-groups .group-list > li').evaluateAll(items => items.map(li => [li.querySelector('h3').textContent, [...li.querySelectorAll('.group-members li')].map(m => m.textContent)])),
      [['Red', ['Ada · Retailer', 'Ben · Wholesaler']], ['Blue', ['Cy · Retailer', 'Dee · Wholesaler']]]);
    assert.equal(await teacher.locator('.lobby-groups button').count(), 0, 'the host only watches groups form');
    assert.equal(await teacher.locator('.start-review div', { hasText: 'Groups' }).innerText(), 'Groups\nRed: Ada (Retailer), Ben (Wholesaler); Blue: Cy (Retailer), Dee (Wholesaler)');
    await teacher.getByRole('button', { name: /Start multiplayer game/ }).click();
    await teacher.locator('.leaderboard').waitFor();
    assert.deepEqual(await rows(teacher), [['—', 'Blue', 'Cy (Retailer), Dee (Wholesaler)', '0 / 24', '$0.00', '—'], ['—', 'Red', 'Ada (Retailer), Ben (Wholesaler)', '0 / 24', '$0.00', '—']]);

    // Each group advances when its own members have ordered.
    await play([ada, ben], [6, 7]); await play([ada, ben], [6, 7]); await play([ada, ben], [6, 7]);
    assert.deepEqual([(await state(ada)).week, (await state(cy)).week], [4, 1]);
    await play([cy, dee], [9, 9]);
    assert.deepEqual([(await state(ada)).week, (await state(cy)).week], [4, 2]);
    assert.equal(await ada.locator('.multiplayer-turn strong').innerText(), 'Red · Group class');
    assert.deepEqual(await ada.locator('.turn-roles span').allInnerTexts(), ['Retailer · Choosing…', 'Wholesaler · Choosing…', 'Distributor · Auto', 'Manufacturer · Auto']);
    assert.equal(await ada.locator('.leaderboard .result-cards li.you strong').innerText(), 'Red · Your group');
    const redView = await state(ada);
    assert.deepEqual([redView.gameKind, redView.group.name, redView.parties.map(p => p.role), redView.waitingFor, redView.leaderboard.map(r => r.nickname)], ['groups', 'Red', ['Retailer', 'Wholesaler'], ['Retailer', 'Wholesaler'], ['Red', 'Blue']]);

    // Blue's Retailer orders, then the teacher refreshes: the checkpoint keeps both groups and Cy's pending order.
    await command(cy, { type: 'order', week: 2, amount: 11 });
    await wait(cy, () => window.beerGameAgent.state().orderStatus?.state === 'accepted');
    const saveBefore = await saved(teacher);
    assert.deepEqual([saveBefore.challengeGames.map(([id, game]) => [id, game.week]), saveBefore.groupPending.map(([id, pending]) => [id, pending])], [[['g1', 4], ['g2', 2]], [['g1', {}], ['g2', { Retailer: 11 }]]]);
    await teacher.reload();
    await h.row(teacher, 'Group class').getByRole('button', { name: 'Resume game' }).click();
    await teacher.locator('.leaderboard tbody tr').first().waitFor();
    await play([dee], [5]);
    assert.equal((await state(cy)).lastWeek.parties.find(p => p.role === 'Retailer').order, 11);
    // Ben refreshes and returns to Red at the same week.
    await ben.reload();
    await ben.getByRole('button', { name: 'Resume game' }).click();
    await wait(ben, () => window.beerGameAgent.state().canOrder);
    assert.deepEqual([(await state(ben)).group.name, (await state(ben)).week], ['Red', 4]);

    // Blue completes week 24 first: it ranks first; nothing is revealed while Red plays on.
    for (let week = 3; week <= 24; week++) await play([cy, dee], [8, week % 4 + 5]);
    await teacher.locator('.leaderboard tbody tr', { hasText: 'Finished' }).waitFor();
    const ranked = await rows(teacher);
    assert.deepEqual(ranked.map(r => [r[0], r[1], r[3]]), [['1', 'Blue', 'Finished'], ['—', 'Red', '3 / 24']]);
    assert.match(ranked[0][5], /^\d+:\d\d$/);
    const blueDone = await state(cy);
    assert.deepEqual([blueDone.phase, blueDone.revealed, blueDone.debrief, blueDone.parties.map(p => p.role)], ['complete', false, null, ['Retailer', 'Wholesaler']]);
    await cy.locator('.completion', { hasText: 'Hidden information is revealed when every group has finished.' }).waitFor();
    assert.equal(await cy.locator('.debrief').count(), 0);

    // Finish classroom: Red stops as incomplete; each member sees only their own group's full chain and debrief.
    await teacher.getByRole('button', { name: 'Finish classroom' }).click();
    assert.equal(h.dialogs.at(-1), 'Finish the classroom? 1 unfinished group will stop and be marked incomplete.');
    await teacher.locator('.leaderboard tbody tr', { hasText: 'Incomplete · 3 / 24' }).waitFor();
    assert.deepEqual(await teacher.locator('.class-counts li').allInnerTexts(), ['Playing 0', 'Disconnected 0', 'Finished 1', 'Incomplete 1', 'Your connection: online']);
    const final = {};
    for (const [name, page] of [['ada', ada], ['ben', ben], ['cy', cy], ['dee', dee]]) {
      await wait(page, () => window.beerGameAgent.state().revealed);
      await page.locator('.debrief').waitFor();
      final[name] = { state: await state(page), history: (await command(page, { type: 'history' })).history };
      assert.equal(final[name].state.parties.length, 4); assert.equal(final[name].state.canOrder, false);
    }
    assert.deepEqual(final.ada.history, final.ben.history); assert.deepEqual(final.cy.history, final.dee.history);
    assert.deepEqual([final.ada.history.length, final.cy.history.length], [3, 24]);
    assert.equal(final.ada.history[0].demand, final.cy.history[0].demand, 'every group has the same customer demand');
    assert.notDeepEqual(final.ada.history[0].parties, final.cy.history[0].parties);
    assert.deepEqual(final.ada.state.revealedRoles, ['Distributor', 'Manufacturer']);
    const board = final.cy.state.leaderboard;
    assert.equal(final.cy.state.debrief.team.totalCost, board.find(r => r.nickname === 'Blue').cost);
    assert.equal(final.ada.state.debrief.team.totalCost, board.find(r => r.nickname === 'Red').cost);
    assert.equal(await ada.locator('.completion h2').innerText(), 'Classroom finished');
    assert.equal(await cy.locator('.completion h2').innerText(), 'Game complete');
    assert.match(await ada.locator('.result-cards li').first().innerText(), /^1\. Blue\nFinished\nCy \(Retailer\), Dee \(Wholesaler\)\nCost \$[\d,.]+ · Time \d+:\d\d$/);
    await h.noOverflow(ada);
    assert.deepEqual(h.errors, []);
  } finally { await h.close(); }
});
