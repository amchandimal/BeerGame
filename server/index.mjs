import { createServer } from 'node:http';
import { randomInt, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';

const roles = ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'];
const setupRoutes = new Map([['/single-player','Single Player'], ['/multiplayer','Multiplayer'], ['/multiplayer/create','Create a Game'], ['/multiplayer/join','Join a Game'], ['/multiplayer/team-supply-chain','Team Supply Chain'], ['/multiplayer/classroom-challenge','Classroom Individual Challenge'], ['/multiplayer/classroom-group-challenge','Classroom Group Challenge']]);
// Six-digit join code from typed or pasted text: whitespace, dashes and dots are ignored, and an invitation link to this site gives its code. Keep in step with joinCode in src/app/lobby.ts.
export function joinCode(input, host) {
  const text = String(input ?? '').trim(), link = text.match(/^https?:\/\/([^/?#]+)\/multiplayer\/join\/(\d{6})\/?(?:[?#].*)?$/i);
  if (link) return link[1].toLowerCase() === String(host).toLowerCase() ? link[2] : null;
  const digits = text.replace(/[\s.·\-\u2010-\u2015]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}
// Short-lived Cloudflare TURN servers for one room member, with port 53 (blocked by browsers) dropped; STUN comes from /rtc-config. Errors carry no secrets or response text.
export async function cloudflareIce({ keyId, token, ttl }, request = fetch) {
  let response, body;
  try {
    response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/generate-ice-servers`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ttl }), signal: AbortSignal.timeout(3000) });
    if (response.ok) body = await response.json();
  } catch (e) { throw new Error(e?.name === 'TimeoutError' ? 'timed out after 3 seconds' : 'request failed'); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const iceServers = (Array.isArray(body?.iceServers) ? body.iceServers : []).flatMap(s => {
    const urls = [s?.urls].flat().filter(url => typeof url === 'string' && /^turns?:/.test(url) && !/:53(?:\?|$)/.test(url));
    return urls.length && typeof s.username === 'string' && typeof s.credential === 'string' ? [{ urls, username: s.username, credential: s.credential }] : [];
  });
  if (!iceServers.length) throw new Error('no TURN servers in the response');
  return iceServers;
}
// Revokes one Cloudflare TURN credential (by its username) before it expires: one attempt, 3-second timeout. Errors carry no secrets or response text.
export async function revokeCloudflareIce({ keyId, token }, username, request = fetch) {
  let response;
  try { response = await request(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(keyId)}/credentials/${encodeURIComponent(username)}/revoke`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(3000) }); }
  catch (e) { throw new Error(e?.name === 'TimeoutError' ? 'timed out after 3 seconds' : 'request failed'); }
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
}
// finishedMs: how long a finished room still admits returning players, so one who missed the reveal receives the final results.
// turnFetch, turnPerMinute: the Cloudflare TURN requests (replaced in tests) and the server-wide cap on credentials issued per minute. revealGraceMs: how long after the reveal players' credentials are revoked.
export function createSignalingServer({ reconnectMs = 24 * 60 * 60 * 1000, awayMs = 60000, finishedMs = 30 * 60 * 1000, turnFetch = fetch, turnPerMinute = 120, revealGraceMs = 30000 } = {}) {
  const production = process.env.NODE_ENV === 'production';
  const publicOrigin = process.env.PUBLIC_ORIGIN;
  if (production && (!publicOrigin || new URL(publicOrigin).protocol !== 'https:')) throw new Error('Production requires PUBLIC_ORIGIN=https://your-domain');
  const { CLOUDFLARE_TURN_KEY_ID: keyId, CLOUDFLARE_TURN_KEY_API_TOKEN: token, TURN_TTL_SECONDS: ttl, STUN_URLS, TURN_URLS } = process.env; // Empty values (as Compose passes them) count as unset.
  const cloudflare = keyId || token ? { keyId, token, ttl: Number(ttl || 10800) } : null; // Credentials go only to room members, over their signaling socket.
  if (cloudflare && (!keyId || !token)) throw new Error('Set both CLOUDFLARE_TURN_KEY_ID and CLOUDFLARE_TURN_KEY_API_TOKEN, or neither.');
  if (cloudflare && TURN_URLS) throw new Error('Configure either Cloudflare TURN (CLOUDFLARE_TURN_KEY_ID) or static TURN_URLS, not both.');
  if (cloudflare && !(Number.isInteger(cloudflare.ttl) && cloudflare.ttl > 0)) throw new Error('TURN_TTL_SECONDS must be a whole number of seconds.');
  const publicIce = [{ urls: (STUN_URLS || (cloudflare ? 'stun:stun.cloudflare.com:3478' : 'stun:stun.l.google.com:19302')).split(',') }];
  if (TURN_URLS) publicIce.push({ urls: TURN_URLS.split(','), username: process.env.TURN_USERNAME || '', credential: process.env.TURN_PASSWORD || '' }); // Static TURN for self-hosters.
  const rooms = new Map();
  const ended = new Map(); // Codes of recently closed rooms, so a late join is told the game ended.
  const clients = new Map();
  // A join failure with a reason the client turns into a next action: invalid, unknown, ended, started or full.
  const refuse = (reason, message) => Object.assign(new Error(message), { reason });
  const webRoot = resolve(fileURLToPath(new URL('../dist/beer-game/browser/', import.meta.url)));
  const held = new WeakMap(); // Socket → messages queued until its TURN credentials have gone first (at most 3 seconds).
  const send = (socket, data) => { if (held.has(socket)) held.get(socket).push(data); else if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
  const issued = new WeakSet(); let iceWindow = { start: 0, count: 0 };
  // Best effort: a failure is logged without secrets and never retried; the credential then expires after its TTL.
  const revokeNames = names => { for (const username of names) revokeCloudflareIce(cloudflare, username, turnFetch).catch(e => console.warn(`Cloudflare TURN credential not revoked (${e.message}); it expires on its own.`)); };
  // client.turn: the usernames issued to the member's current (or last) connection, in memory only and never logged; names is null while the request is in flight.
  const revoke = client => { const turn = client.turn; client.turn = null; if (turn?.names) revokeNames(turn.names); };
  // One Cloudflare request per connection, within the server-wide cap. Its `ice` message precedes whatever is queued for that socket meanwhile (session, room, signals); on failure the player continues with STUN only.
  const issueIce = client => {
    const socket = client.socket;
    if (!cloudflare || issued.has(socket)) return;
    issued.add(socket);
    if (Date.now() - iceWindow.start >= 60000) iceWindow = { start: Date.now(), count: 0 };
    if (iceWindow.count++ === turnPerMinute) console.warn(`Cloudflare TURN: ${turnPerMinute} credentials issued this minute; further players use STUN only until the next minute.`);
    if (iceWindow.count > turnPerMinute) return;
    held.set(socket, []);
    const turn = client.turn = { names: null };
    cloudflareIce(cloudflare, turnFetch).then(iceServers => {
      turn.names = [...new Set(iceServers.map(s => s.username))];
      if (client.turn === turn) return [{ type: 'ice', iceServers }];
      revokeNames(turn.names); return []; // Left, removed or replaced while the request was in flight.
    }, e => { console.warn(`Cloudflare TURN credentials unavailable (${e.message}); the player continues with STUN only.`); if (client.turn === turn) client.turn = null; return []; })
      .then(first => { const queued = held.get(socket); held.delete(socket); for (const data of [...first, ...queued]) send(socket, data); });
  };
  // Credentials only for a member with an online counterpart to connect to: the host once any guest is online, a guest once the host is, never a member alone. Runs whenever a member comes online (create, join, resume).
  const issueNeeded = room => {
    const online = m => m.socket.readyState === WebSocket.OPEN, host = room.members.get(room.host), members = [...room.members.values()];
    for (const m of members) if (online(m) && (m === host ? members.some(o => o !== m && online(o)) : online(host))) issueIce(m);
  };
  // After the reveal players need no relay: their credentials are revoked once the final snapshot has had time to arrive (at once if they disconnect first). The host's stays while the finished room admits returning players (who get their own on resume) and goes when it expires, the host leaves or disconnects.
  const revokeAfterReveal = room => {
    const live = [...room.members.values()].filter(m => m.id !== room.host && m.turn).map(m => [m, m.turn]);
    if (live.length) setTimeout(() => { for (const [m, turn] of live) if (m.turn === turn) revoke(m); }, revealGraceMs).unref();
  };
  const roomView = room => ({ name: room.name, code: room.code, visibility: room.visibility, kind: room.kind, hostPlays: room.hostPlays, challenge: room.challenge, host: room.host, started: room.started, humanRoles: room.humanRoles, automated: room.automated, waiting: room.waiting, takeBack: room.takeBack, absentAtStart: room.absentAtStart, groups: room.kind === 'groups' ? room.groups : undefined, members: [...room.members.values()].map(m => ({ id: m.id, role: m.role, nickname: m.nickname, online: m.socket.readyState === WebSocket.OPEN, connection: m.connection, left: !!m.left, ...(room.kind === 'groups' ? { group: m.group } : {}) })) });
  const broadcast = room => { for (const m of room.members.values()) send(m.socket, { type: 'room', room: roomView(room) }); };
  // In a started Team game (or a group of a Classroom Group Challenge) a guest's seat outlives leaving; the creator decides whether the system plays it.
  const teamInPlay = room => (room.kind === 'team' || room.kind === 'groups') && room.started && !room.finished;
  // Where a seat's C-01 state lives (humanRoles, automated, waiting, takeBack, absentAtStart): the room, or the member's group in a Classroom Group Challenge.
  const chainOf = (room, group) => room.kind === 'groups' ? room.groups.find(g => g.id === group) : room;
  const removeMember = client => {
    const room = client.room;
    if (!room) return;
    client.room = null; room.members.delete(client.id); revoke(client);
    if (client.id === room.host) {
      rooms.delete(room.code); ended.set(room.code, Date.now());
      if (ended.size > 10000) ended.delete(ended.keys().next().value);
      for (const m of room.members.values()) { send(m.socket, { type: 'closed', message: 'The host ended the supply chain or its reconnect window expired.' }); m.room = null; m.role = null; revoke(m); }
    } else broadcast(room);
  };
  const expireRooms = () => {
    for (const room of rooms.values()) if (room.finished && Date.now() - room.finishedAt >= finishedMs) { // Players on their final screens keep them.
      rooms.delete(room.code); ended.set(room.code, Date.now());
      for (const m of room.members.values()) { m.room = null; revoke(m); }
    }
    for (const room of rooms.values()) for (const member of room.members.values()) {
      if (member.disconnectedAt && Date.now() - member.disconnectedAt >= reconnectMs) removeMember(member);
    }
    for (const [code, at] of ended) { if (Date.now() - at < reconnectMs) break; ended.delete(code); } // Oldest first.
  };
  const server = createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
    if (process.env.INDEXABLE !== 'true') res.setHeader('X-Robots-Tag', 'noindex, nofollow');
    if (!['GET', 'HEAD'].includes(req.method)) { res.writeHead(405, { Allow: 'GET, HEAD' }); res.end(); return; }
    const pathname = new URL(req.url, 'http://localhost').pathname;
    const joinPath = /^\/multiplayer\/join\/\d{6}\/?$/.test(pathname);
    if (pathname === '/3rdpartylicenses.txt') {
      try { const content = await readFile(resolve(webRoot, '../3rdpartylicenses.txt')); res.writeHead(200, { 'Content-Type':'text/plain; charset=utf-8' }); res.end(req.method === 'HEAD' ? undefined : content); }
      catch { res.writeHead(404); res.end(); }
      return;
    }
    if (pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}'); return; }
    if (pathname === '/rtc-config') { // Never Cloudflare credentials: those go only to room members.
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ iceServers: publicIce })); return;
    }
    try {
      const pages = new Set(['/about', '/how-to-play', '/open-source', '/privacy', '/terms']);
      if (pathname.endsWith('/') && (joinPath || pages.has(pathname.slice(0,-1)) || setupRoutes.has(pathname.slice(0,-1)))) { res.writeHead(308, { Location: pathname.slice(0,-1) }); res.end(); return; }
      if (pathname.endsWith('.html') && pages.has(pathname.slice(0,-5))) { res.writeHead(308, { Location: pathname.slice(0,-5) }); res.end(); return; }
      const root = process.env.DEV_PUBLIC_PAGES === 'true' && (pages.has(pathname) || ['/site.css','/robots.txt','/sitemap.xml','/LICENSE.txt'].includes(pathname)) ? resolve(webRoot, '../../../public/generated') : webRoot;
      const path = resolve(root, '.' + decodeURIComponent(pathname === '/' || joinPath || setupRoutes.has(pathname) ? '/index.html' : pages.has(pathname) ? pathname + '.html' : pathname));
      if (!path.startsWith(root + sep)) { res.writeHead(403); res.end(); return; }
      let content = await readFile(path);
      if (joinPath) res.setHeader('X-Robots-Tag', 'noindex, nofollow');
      if (setupRoutes.has(pathname) || joinPath) {
        content = content.toString().replace(/<title>[^<]*<\/title>/, `<title>${setupRoutes.get(pathname) ?? 'Join a Game'} | beergame.io</title>`)
          .replace('<h1>Beer Game Online</h1>', `<h1>${setupRoutes.get(pathname) ?? 'Join a Game'}</h1>`)
          .replace(/(<meta\s+property="og:title"\s+content=")[^"]+("\s*\/?>)/, `$1${setupRoutes.get(pathname) ?? 'Join a Game'} | beergame.io$2`)
          .replace(/(<link\s+rel="canonical"\s+href=")([^"]+)(")/, (_,a,url,b) => a + new URL(pathname,url).href + b)
          .replace(/(<meta\s+property="og:url"\s+content=")([^"]+)(")/, (_,a,url,b) => a + new URL(pathname,url).href + b);
      }
      res.writeHead(200, { 'Content-Type': ({ '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.xml': 'application/xml' })[extname(path)] || 'application/octet-stream', 'Cache-Control': /-[A-Z0-9]{8,}\.(js|css)$/i.test(path) ? 'public, max-age=31536000, immutable' : 'no-cache' });
      res.end(req.method === 'HEAD' ? undefined : content);
    } catch { res.writeHead(404); res.end('Build the app with npm run build first, or use npm start for development.'); }
  });
  const wss = new WebSocketServer({ server, path: '/signaling', maxPayload: 65536, verifyClient: ({ origin }) => clients.size < 1000 && (!publicOrigin || origin === publicOrigin) });
  wss.on('connection', (socket, req) => {
    const site = req.headers.host ?? ''; // Invitation links pasted as a code must point at this site.
    let client = { id: randomUUID(), token: randomUUID(), connection: 1, socket, room: null, role: null, group: null, nickname: '', attempts: [], alive: true, messageCount: 0, windowStart: Date.now(), turn: null };
    clients.set(client.id, client);
    send(socket, { type: 'welcome', id: client.id });
    socket.on('pong', () => { client.alive = true; });
    socket.on('message', raw => {
      if (Date.now() - client.windowStart > 1000) { client.messageCount = 0; client.windowStart = Date.now(); }
      if (++client.messageCount > 100) { socket.close(1008, 'Message rate exceeded'); return; }
      let request; // Echoed with errors so the client can show them beside the field that caused them.
      try {
        const msg = JSON.parse(raw.toString());
        request = typeof msg.type === 'string' ? msg.type.slice(0, 20) : undefined;
        if (client.socket !== socket) return;
        expireRooms();
        if (msg.type === 'check' || msg.type === 'resume') {
          if (client.room) throw new Error('Already connected to a game.');
          const room = rooms.get(String(msg.code));
          const found = room && [...room.members.values()].find(m => m.token === msg.token);
          // A finished room still admits its players while the host is online, so one who missed the reveal receives the final snapshot.
          const late = found && room.finished && (found.id === room.host || room.members.get(room.host).socket.readyState !== WebSocket.OPEN);
          const member = late ? undefined : found;
          const removed = late ? 'finished' : room && !room.finished && !member ? room.removed.get(msg.token) : undefined; // The host removed this player, or started without them.
          if (msg.type === 'check') { send(socket, { type: 'available', available: !!member, ...(removed ? { reason: removed } : {}) }); return; }
          if (!member) { send(socket, { type: 'resume-unavailable', message: removed === 'removed' ? 'The host removed you from this game before it started. You can join another game.' : removed === 'finished' ? 'This game is over and its results are no longer available. You can create or join another game.' : removed ? 'The host started this game without you. You can join another game.' : 'This saved game has ended or expired. You can create or join another game.' }); return; }
          clients.delete(client.id);
          const oldSocket = member.socket;
          revoke(member); // The previous connection's credential: Resume and Reconnect rebuild every peer from fresh configuration.
          client = member; client.socket = socket; client.disconnectedAt = 0; client.left = false; client.connection++; client.alive = true;
          const chain = chainOf(room, client.group);
          if (chain) {
            delete chain.waiting[client.role]; chain.absentAtStart = chain.absentAtStart.filter(role => role !== client.role);
            if (!room.finished && chain.automated[client.role] && !chain.takeBack.includes(client.role)) chain.takeBack.push(client.role); // Plays again once the host's week advances.
          }
          clients.set(client.id, client);
          if (oldSocket !== socket) oldSocket.close(4001, 'Session resumed in another tab');
          issueNeeded(room); send(socket, { type: 'session', id: client.id, token: client.token }); broadcast(room);
        } else if (msg.type === 'leave') {
          if (client.room && teamInPlay(client.room) && client.id !== client.room.host) { client.left = true; revoke(client); socket.close(1000, 'Left the game'); }
          else removeMember(client);
        } else if (msg.type === 'decide') {
          // In a Classroom Group Challenge the host names the group; a player decides only for their own group.
          const room = client.room, chain = room && chainOf(room, client.id === room.host ? msg.group : client.group);
          const seat = chain && [...room.members.values()].find(m => m.role === msg.role && (room.kind !== 'groups' || m.group === chain.id));
          if (!chain || !teamInPlay(room) || !chain.humanRoles.includes(msg.role) || typeof msg.system !== 'boolean') throw new Error('There is no decision to make for that role.');
          if (chain.automated[msg.role]) throw new Error(`${chain.automated[msg.role]} already let the system play ${msg.role}.`);
          if (seat && !seat.left) throw new Error(`${seat.nickname} has not left the game.`);
          if (client.id !== room.host && room.members.get(room.host).socket.readyState === WebSocket.OPEN) throw new Error('Only the host can decide while they are online.');
          if (!msg.system && chain.waiting[msg.role]) throw new Error(`${chain.waiting[msg.role]} already chose to keep waiting.`);
          if (msg.system) { chain.automated[msg.role] = client.nickname; delete chain.waiting[msg.role]; } else chain.waiting[msg.role] = client.nickname;
          broadcast(room);
        } else if (msg.type === 'handback') {
          const room = client.room, chain = room && chainOf(room, msg.group); // The host's week advanced, so a returned player plays from the new week.
          if (room?.host === client.id && chain?.takeBack.includes(msg.role)) { delete chain.automated[msg.role]; chain.takeBack = chain.takeBack.filter(role => role !== msg.role); broadcast(room); }
        } else if (msg.type === 'finished') {
          if (client.room?.host === client.id && !client.room.finished) { client.room.finished = true; client.room.finishedAt = Date.now(); revokeAfterReveal(client.room); }
        } else if (msg.type === 'create' || msg.type === 'join') {
          if (client.room) throw new Error('Already in a supply chain. Leave it before joining another.');
          const name = typeof msg.name === 'string' ? msg.name.trim() : '';
          if (msg.type === 'create' && (!name || name.length > 60)) throw new Error('Supply chain name must be 1–60 characters.');
          let room;
          if (msg.type === 'create') {
            const visibility = msg.visibility ?? 'network';
            if (!['network', 'dyadic', 'none'].includes(visibility)) throw new Error('Choose Network Wide, Dyadic or None for information visibility.');
            if (rooms.size >= 200) throw new Error('Room capacity reached. Try again later.');
            const kind = msg.kind ?? 'team';
            if (!['team', 'classroom', 'groups'].includes(kind)) throw new Error('Choose a valid game mode.');
            if (msg.hostPlays !== undefined && typeof msg.hostPlays !== 'boolean') throw new Error('hostPlays must be a boolean.');
            if (kind === 'team' && msg.hostPlays === false) throw new Error('Only a classroom host can choose not to play.');
            if (kind === 'groups' && msg.hostPlays === true) throw new Error('In a Classroom Group Challenge the host hosts only.');
            let challenge = null;
            if (kind !== 'team') {
              const c = msg.challenge, demand = !!c && ['sma', 'wma', 'cyclic'].includes(c.method) && Number.isInteger(c.seed) && c.seed >= 0 && c.seed <= 4294967295;
              if (kind === 'classroom' && (!demand || !roles.includes(c.role))) throw new Error('Choose a role, demand method and seed (0–4294967295).');
              if (!demand) throw new Error('Choose a demand method and seed (0–4294967295).');
              challenge = kind === 'classroom' ? { role: c.role, method: c.method, seed: c.seed } : { method: c.method, seed: c.seed }; // Groups share the customer demand only.
            }
            let code; do { code = String(randomInt(0, 1000000)).padStart(6, '0'); } while (rooms.has(code));
            // removed: private tokens of players the host removed or started without, so their saved game can say why it is gone.
            // groups: a Classroom Group Challenge's groups, each with its own C-01 state; groupSeq numbers their ids.
            room = { name, code, visibility, kind, challenge, hostPlays: kind !== 'groups' && msg.hostPlays !== false, host: client.id, started: false, humanRoles: [], automated: {}, waiting: {}, takeBack: [], absentAtStart: [], groups: [], groupSeq: 0, removed: new Map(), members: new Map() };
            rooms.set(code, room); ended.delete(code);
          } else {
            client.attempts = client.attempts.filter(t => Date.now() - t < 60000);
            if (client.attempts.length >= 10) throw new Error('Too many join attempts. Wait one minute.');
            client.attempts.push(Date.now());
            const code = joinCode(msg.code, site);
            if (!code) throw refuse('invalid', 'Enter the six-digit code or paste the invitation link.');
            room = rooms.get(code);
            if (!room || room.finished) throw room || ended.has(code) ? refuse('ended', `Game ${code} has ended. Ask the host for a new code.`) : refuse('unknown', `No game uses code ${code}. Check the code with your host.`);
            if (room.started) throw refuse('started', `Game ${code} has already started. Players in it can resume from the browser they joined with.`);
            const capacity = room.kind === 'team' ? 4 : 32;
            if (room.members.size >= capacity) throw refuse('full', `This lobby is full (${capacity} of ${capacity} players). Create your own game, or ask the host to remove an inactive player.`);
          }
          client.role = room.kind === 'classroom' && (client.id !== room.host || room.hostPlays) ? room.challenge.role : null; client.group = null;
          client.room = room; room.members.set(client.id, client);
          issueNeeded(room); send(socket, { type: 'session', id: client.id, token: client.token }); broadcast(room);
         } else if (msg.type === 'nickname') {
          const room = client.room;
          const nickname = typeof msg.nickname === 'string' ? msg.nickname.trim() : '';
          if (!room || room.started || !nickname || nickname.length > 24) throw new Error('Enter a nickname (1–24 characters) before starting.');
          if ([...room.members.values()].some(m => m.id !== client.id && m.nickname.toLowerCase() === nickname.toLowerCase())) throw new Error('That nickname is taken.');
          client.nickname = nickname; broadcast(room);
        } else if (msg.type === 'claim') {
          const room = client.room;
          if (!room || room.kind === 'classroom' || room.started || !roles.includes(msg.role)) throw new Error('Choose an available role before the game starts.');
          if (room.kind === 'groups' && !client.group) throw new Error('Join a group before choosing a role.');
          // Before start a player may switch roles. Each message is handled whole, so two players (in a group: two members of it) never hold one role.
          if ([...room.members.values()].some(m => m.role === msg.role && m !== client && m.group === client.group)) throw new Error('That role has already been taken.');
          client.role = msg.role; broadcast(room);
        } else if (msg.type === 'group-create' || msg.type === 'group-join') {
          const room = client.room;
          if (!room || room.kind !== 'groups' || room.started || client.id === room.host) throw new Error('Groups can change only in a Classroom Group Challenge lobby before it starts.');
          if (!client.nickname) throw new Error('Enter a nickname before joining a group.');
          let group;
          if (msg.type === 'group-create') {
            const name = typeof msg.name === 'string' ? msg.name.trim() : '';
            if (!name || name.length > 24) throw new Error('Group name must be 1–24 characters.');
            if (room.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) throw new Error('That group name is taken.');
            if (room.groups.length >= 8) throw new Error('This classroom has 8 groups already. Join one of them.');
            group = { id: 'g' + ++room.groupSeq, name, humanRoles: [], automated: {}, waiting: {}, takeBack: [], absentAtStart: [] };
            room.groups.push(group);
          } else {
            group = room.groups.find(g => g.id === msg.group);
            if (!group) throw new Error('That group no longer exists.');
            if (group.id !== client.group && [...room.members.values()].filter(m => m.group === group.id).length >= 4) throw new Error(`${group.name} is full (4 of 4 players). Join another group or create one.`);
          }
          // Each message is handled whole: a switch frees the old role at once, and a group never takes a fifth member.
          if (client.group !== group.id) { client.group = group.id; client.role = null; }
          broadcast(room);
        } else if (msg.type === 'remove') {
          const room = client.room, member = room?.members.get(String(msg.id));
          if (!room || room.host !== client.id || room.started) throw new Error('Only the host can remove players, and only before the game starts.');
          if (!member || member.id === room.host) throw new Error('That player is not in this lobby.');
          if (member.socket.readyState === WebSocket.OPEN) throw new Error(`${member.nickname || 'That player'} is connected again.`);
          room.members.delete(member.id); room.removed.set(member.token, 'removed'); revoke(member); broadcast(room);
        } else if (msg.type === 'started') {
          const room = client.room;
          if (!room || room.host !== client.id) throw new Error('Only the host can start.');
          // Disconnected members the host starts without: a Team seat with a nickname and role stays and the system plays it, as after leaving (in a group, only beside a member who stays); anyone else is removed.
          const without = room.started || !Array.isArray(msg.without) ? [] : [...room.members.values()].filter(m => msg.without.includes(m.id));
          if (without.some(m => m.id === room.host || m.socket.readyState === WebSocket.OPEN)) throw new Error('Only disconnected players can be left out.');
          const staying = [...room.members.values()].filter(m => !without.includes(m));
          const kept = without.filter(m => m.role && m.nickname && (room.kind === 'team' || room.kind === 'groups' && staying.some(s => s.group === m.group && s.id !== room.host)));
          const players = staying.filter(m => room.hostPlays || m.id !== room.host);
          if (room.kind === 'groups' && players.some(m => !m.group)) throw new Error('Every player must join a group before starting.');
          if (!players.length || players.some(m => !m.role)) throw new Error('At least one player must join and every joined player must select a role.');
          if (room.started) throw new Error('This game has already started.');
          if (staying.some(m => !m.nickname)) throw new Error('Every player must enter a nickname.');
          if (staying.some(m => m.socket.readyState !== WebSocket.OPEN)) throw new Error('Wait for every player to reconnect.');
          for (const m of without) if (!kept.includes(m)) { room.members.delete(m.id); room.removed.set(m.token, 'started-without'); revoke(m); }
          const seated = [...room.members.values()].filter(m => players.includes(m) || kept.includes(m));
          if (room.kind === 'groups') {
            room.groups = room.groups.filter(g => seated.some(m => m.group === g.id)); // Empty groups are dropped.
            for (const g of room.groups) { g.humanRoles = seated.filter(m => m.group === g.id).map(m => m.role); g.absentAtStart = kept.filter(m => m.group === g.id).map(m => m.role); }
          } else { room.absentAtStart = kept.map(m => m.role); room.humanRoles = seated.map(m => m.role); } // absentAtStart: their seat says they were offline at the start, not that they left.
          for (const m of kept) { m.left = true; chainOf(room, m.group).automated[m.role] = client.nickname; }
          room.started = true; broadcast(room);
        } else if (msg.type === 'signal') {
          const peer = clients.get(msg.to);
          if (!client.room || !peer || peer.room !== client.room || peer.id === client.id || (client.id !== client.room.host && peer.id !== client.room.host)) throw new Error('Peer is not in this supply chain.');
          send(peer.socket, { type: 'signal', from: client.id, signal: msg.signal });
        }
      } catch (e) { send(socket, { type: 'error', message: e.message || 'Invalid request.', request, reason: e.reason }); }
    });
    socket.on('close', () => {
      if (client.socket !== socket) return; // An old socket a resume replaced: the new connection keeps its credential.
      clients.delete(client.id);
      revoke(client); // The browser closes its peers when signaling drops; Resume and Reconnect get fresh credentials when needed.
      const room = client.room;
      if (!room) return;
      const at = client.disconnectedAt = Date.now();
      const chain = chainOf(room, client.group);
      if (chain) chain.takeBack = chain.takeBack.filter(role => role !== client.role);
      broadcast(room);
      // A plain disconnect counts as leaving after a grace period, so a refresh does not prompt the creator.
      if (teamInPlay(room) && client.id !== room.host && !client.left) setTimeout(() => {
        if (client.disconnectedAt === at && rooms.get(room.code) === room && room.members.has(client.id)) { client.left = true; broadcast(room); }
      }, awayMs).unref();
    });
    socket.on('error', () => socket.close());
  });
  const heartbeat = setInterval(() => { expireRooms(); for (const c of clients.values()) { if (!c.alive) c.socket.terminate(); else { c.alive = false; c.socket.ping(); } } }, 15000);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
  return { server, wss };
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server, wss } = createSignalingServer();
  server.listen(Number(process.env.PORT || 8787), process.env.HOST || '127.0.0.1', () => console.log(`Beer Game app/signaling listening on port ${server.address().port}`));
  const stop = () => { for (const socket of wss.clients) socket.close(1001, 'Server restarting'); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 5000).unref(); };
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
}
