import { ChallengeConfig, DemandConfig, demandScenario, ScoreRow, rankScores, scoreStatus } from './challenge';
import { signal } from '@angular/core';
import { BeerGame, Party, Role, ROLES } from './game';
import { loadRtcConfig } from './rtc-config';
import { InformationVisibility, dataScope, visibleHistory, visibleParties, visiblePending, visibleRoles, hiddenParty } from './visibility';
import { list, lobbyStatus, lobbySummary, startReview, startWithoutPrompt } from './lobby';
import { SavedSession, readSaves, removeSave, restoreGame, saveKey, writeSave } from './saves';

// group: the member's group in a Classroom Group Challenge.
export interface Member { id: string; role: Role | null; nickname: string; online?: boolean; connection?: number; left?: boolean; group?: string | null; }
// A group of a Classroom Group Challenge: its own chain, with the same C-01 state as a Team room (set at start).
export interface Group { id: string; name: string; humanRoles?: Role[]; automated?: Partial<Record<Role, string>>; waiting?: Partial<Record<Role, string>>; takeBack?: Role[]; absentAtStart?: Role[]; }
// automated: system-played role → who decided; waiting: role → who chose to keep waiting; takeBack: returned players, playing again after the host's next week; absentAtStart: seats the host started without, until their player returns.
// kind: team (Team Supply Chain), classroom (Classroom Individual Challenge) or groups (Classroom Group Challenge, whose challenge has no shared role). group: set only on a chainView of one group.
export interface Room { hostPlays?: boolean; kind: 'team' | 'classroom' | 'groups'; challenge: (DemandConfig & { role?: Role }) | null; name: string; code: string; visibility: InformationVisibility; host: string; started: boolean; humanRoles: Role[]; automated?: Partial<Record<Role, string>>; waiting?: Partial<Record<Role, string>>; takeBack?: Role[]; absentAtStart?: Role[]; groups?: Group[]; group?: string; members: Member[]; }
export interface Absence { role: Role; nickname: string | null; state: 'connecting' | 'disconnected' | 'left' | 'waiting' | 'system' | 'returning'; decidedBy: string | null; canDecide: boolean; message: string; group?: string; }
// One supply chain shaped like a Team room: the room itself, or one group of a Classroom Group Challenge (its members and C-01 state); null for an unknown group.
export function chainView(room: Room, group: string | null | undefined): Room | null {
  if (room.kind !== 'groups') return room;
  const g = room.groups?.find(g => g.id === group);
  return g ? { ...room, group: g.id, humanRoles: g.humanRoles ?? [], automated: g.automated ?? {}, waiting: g.waiting ?? {}, takeBack: g.takeBack ?? [], absentAtStart: g.absentAtStart ?? [], members: room.members.filter(m => m.group === g.id) } : null;
}
// This player's order for the current week: sending, unconfirmed (no reply yet, so it can be sent again), interrupted (no connection to the host) or accepted by the host.
export interface OrderStatus { week: number; amount: number; state: 'sending' | 'unconfirmed' | 'interrupted' | 'accepted'; waitingFor: string[]; message: string; canRetry: boolean; }
export const ACK_MS = 5000; // Without the host's reply by then, the order can be sent again.
interface Peer { pc: RTCPeerConnection; channel?: RTCDataChannel; candidates: RTCIceCandidateInit[]; }
interface Snapshot { type: 'state'; scenario?: readonly number[]; customer?: readonly number[]; week: number; history: { week: number; demand: number | null; parties: Party[] }[]; parties: Party[]; pending: Partial<Record<Role, number>>; submittedRoles: Role[]; revealed?: boolean; }
// A saved game's availability: checking, available, unverified (the check could not finish), or ending (End game for everyone is in progress).
export type SaveCheck = 'checking' | 'available' | 'unverified' | 'ending';
// A save the server reported unavailable, or that this browser ended for everyone: removed from storage, listed with the reason until dismissed.
export interface EndedSave { key: string; save: SavedSession; reason: string; }
const endedReasons: Record<string, string> = { removed: 'The host removed you before it started.', 'started-without': 'The host started without you.', finished: 'The game is over; its results are no longer available.', ended: 'Ended for everyone.' };
const signalingUrl = () => `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signaling`;

export class MultiplayerSession {
  saved: SavedSession | null = null; // This tab's session save: written by persist(), or the save being resumed.
  saves = readSaves(); // Every multiplayer save in this browser, most recent first.
  ended: EndedSave[] = [];
  openElsewhere = (key: string) => false; // Whether another tab has this save open; the app sets it from its tab presence.
  storageWarning = '';
  private token = '';
  private restoring: SavedSession | null = null;
  private finishedSent = false;
  revision = signal(0);
  room: Room | null = null;
  id = '';
  private errorText = '';
  // The form field the current error belongs to; the UI shows it beside that field instead of the general error area.
  errorField: 'code' | 'nickname' | 'order' | 'group' | null = null;
  // Why a join failed, so the UI can offer the next action: invalid, unknown, ended, started or full.
  errorReason: string | null = null;
  fieldErrors = 0; // Counts field errors so the UI can focus the field after each failed submit.
  get error() { return this.errorText; }
  set error(message: string) { this.errorText = message; this.errorField = null; this.errorReason = null; }
  private fieldError(field: 'code' | 'nickname' | 'order' | 'group', message: string, reason: string | null = null) { this.error = message; this.errorField = field; this.errorReason = reason; this.fieldErrors++; }
  status = 'Not connected';
  private checks = new Map<string, SaveCheck>(); // Your games: each save's availability, by save key.
  saveCheck(save: SavedSession) { return this.checks.get(saveKey(save)) ?? null; }
  private lost = false;
  // After the signaling connection drops, the save rejoins in place. Never route this through AppComponent.resumeGame(), which ends a live session first.
  get canReconnect() { return this.lost && !!this.room && this.saved?.room.code === this.room.code; }
  // Resuming a save, or a started game whose state has not arrived from the creator yet.
  get reconnecting() { return this.status === 'Connecting to supply chain…' && !!this.restoring || !!this.room?.started && !this.game && !this.isObserver; }
  game: BeerGame | null = null;
  pending: Partial<Record<Role, number>> = {};
  leaderboard: ScoreRow[] = [];
  private challengeGames = new Map<string, BeerGame>(); // Host: classroom runs by member id, or group chains by group id.
  private groupPending = new Map<string, Partial<Record<Role, number>>>(); // Host: each group's orders for its current week.
  private challengeStarted = 0;
  // A guest's order until the host replies; re-sent unchanged on request, or when the channel to the host reopens.
  private sent: { week: number; amount: number; at: number; acked: boolean } | null = null;
  private ackTimer?: ReturnType<typeof setTimeout>;
  private revealedByHost = false;
  closedNotice = ''; // Set when the room closes after this player's run is over; the final screen stays.
  // Classroom: every run (or group) finished, or the creator finished the classroom and unfinished ones were marked incomplete.
  get classroomOver() { return this.leaderboard.length > 0 && this.leaderboard.every(r => r.finished || r.incomplete); }
  // Hidden information is revealed once play is over: Team at week 24, both classroom modes once every run or group is over. Guests learn it from the creator's unfiltered snapshot.
  get revealed() { return this.isHost ? this.isChallenge ? this.classroomOver : !!this.game?.complete : this.revealedByHost; }
  // This player's run is over: complete, or stopped because the creator finished the classroom.
  get over() { return !!this.game && (this.game.complete || this.isChallenge && this.revealed); }
  get isClassroom() { return this.room?.kind === 'classroom'; } // Classroom Individual Challenge.
  get isGroups() { return this.room?.kind === 'groups'; } // Classroom Group Challenge.
  // Both classroom modes: the host runs every engine and the leaderboard, and Finish classroom applies.
  get isChallenge() { return this.isClassroom || this.isGroups; }
  get isObserver() { return this.isChallenge && this.isHost && this.room?.hostPlays === false; }
  get groups(): Group[] { return this.room?.groups ?? []; }
  get group() { return this.groups.find(g => g.id === this.member?.group) ?? null; }
  private get member() { return this.room?.members.find(m => m.id === this.id); }
  // This player's chain: the Team room, or their group (null for the host of a Classroom Group Challenge, or before joining a group).
  get chain() { return this.room ? chainView(this.room, this.member?.group) : null; }
  // This player's leaderboard row: their own run, or their group.
  get scoreId() { return this.isGroups ? this.member?.group ?? '' : this.id; }
  get nickname() { return this.room?.members.find(m => m.id === this.id)?.nickname ?? ''; }
  get canPlay() { return !this.isObserver && (this.isClassroom ? this.isHost || this.connected(this.room?.host ?? '') : this.isHost ? this.ready : this.connected(this.room?.host ?? '')); }
  private peerSubmittedRoles: Role[] = [];
  get submittedRoles(): Role[] { return this.isHost ? Object.keys(this.pending) as Role[] : this.peerSubmittedRoles; }
  hasSubmitted(role: Role) { return this.submittedRoles.includes(role); }
  private socket?: WebSocket;
  private peers = new Map<string, Peer>();
  private config: RTCConfiguration = { iceServers: [] };
  private generation = 0;
  constructor(private onUpdate: () => void) {}
  get isHost() { return !!this.room && this.room.host === this.id; }
  get role() { return this.room?.members.find(m => m.id === this.id)?.role ?? null; }
  get humanRoles(): Role[] { const chain = this.chain; return chain?.started ? chain.humanRoles : chain?.members.flatMap(m => m.role ? [m.role] : []) ?? []; }
  private handingBack: { group: string | null; role: Role }[] = []; // Roles handed back to returned players until the server confirms.
  private automatedIn(chain: Room) { return (Object.keys(chain.automated ?? {}) as Role[]).filter(role => !this.handingBack.some(h => h.role === role && h.group === (chain.group ?? null))); }
  get automatedRoles(): Role[] { const chain = this.chain; return chain ? this.automatedIn(chain) : []; }
  // Roles whose order each week waits for: the human roster minus roles the system plays after a player left.
  get activeRoles(): Role[] { return this.humanRoles.filter(role => !this.automatedRoles.includes(role)); }
  private activeIn(chain: Room) { const automated = this.automatedIn(chain); return chain.humanRoles.filter(role => !automated.includes(role)); }
  get systemRoles(): Role[] { return this.isGroups && !this.chain ? [] : ROLES.filter(role => this.isClassroom ? role !== this.room?.challenge?.role : !this.activeRoles.includes(role)); }
  isHumanRole(role: Role) { return this.activeRoles.includes(role); }
  get replaced() { return !!this.role && this.automatedRoles.includes(this.role); }
  get ready() {
    const room = this.room, chain = this.chain;
    if (room?.started && !this.isClassroom) return !!chain && this.readyIn(chain);
    return !!room && this.lobbyReady(room.members);
  }
  // Every role a started chain waits for has a player connected to the host.
  private readyIn(chain: Room) { return this.activeIn(chain).every(role => chain.members.some(m => m.role === role && this.connected(m.id))); }
  private lobbyReady(members: Member[]) { const room = this.room!; return members.some(m => m.role) && members.every(m => (m.role || room.hostPlays === false && m.id === room.host) && m.nickname && this.connected(m.id)); }
  // Team players (in a Classroom Group Challenge: group members) who are not playing, with the message and decision the UI and MCP show for each. The group host sees every group's.
  get absences(): Absence[] {
    const room = this.room;
    if (!room?.started || this.isClassroom) return [];
    if (this.isGroups && this.isHost) return this.groups.flatMap(g => this.absencesIn(chainView(room, g.id)!, this.challengeGames.get(g.id) ?? null, `${g.name}: `));
    const chain = this.chain;
    return chain ? this.absencesIn(chain, this.game) : [];
  }
  private absencesIn(chain: Room, game: BeerGame | null, prefix = ''): Absence[] {
    const room = this.room!, week = game?.week ?? 0;
    if (game?.complete) return [];
    const creatorAway = room.members.find(m => m.id === room.host)?.online === false;
    return chain.humanRoles.flatMap(role => {
      const seat = chain.members.find(m => m.role === role), present = !!seat && seat.online !== false, waiting = chain.waiting?.[role] ?? null;
      const who = seat ? `${seat.nickname} (${role})` : `The ${role} player`, canDecide = this.isHost || creatorAway;
      const entry = (state: Absence['state'], message: string, decidedBy: string | null = null, decides = false): Absence[] => [{ role, nickname: seat?.nickname ?? null, state, decidedBy, canDecide: decides, message: prefix + message, ...(chain.group ? { group: chain.group } : {}) }];
      if (this.automatedIn(chain).includes(role)) {
        const by = chain.automated![role]!;
        if (present) return seat!.id === this.id ? entry('returning', `The system is playing ${role} this week. You take over from week ${week + 1}.`, by) : entry('returning', `${seat!.nickname} is back and takes over ${role} from week ${week + 1}.`, by);
        return entry('system', `${who} ${chain.absentAtStart?.includes(role) ? 'was offline at the start' : 'left'}. The system is playing ${role} (decided by ${by}).${creatorAway ? ' Play continues when the host returns.' : ''}`, by);
      }
      if (present) return this.isHost && this.token && !this.connected(seat!.id) ? entry('connecting', `Connecting to ${who}…`) : []; // Not while this browser's own signaling is down.
      if (seat && !seat.left) return entry('disconnected', `${who} disconnected. Play pauses until they return.`);
      if (waiting) return entry('waiting', `Waiting for ${who} to return. ${waiting} chose to keep waiting.`, waiting, canDecide);
      if (!canDecide) return entry('left', `${who} has left. Waiting for the host to decide.`);
      return entry('left', `${who} has left. Let the system play ${role}, or keep waiting?${creatorAway ? ' The host is offline, so your answer applies when they return.' : ''}`, null, true);
    });
  }
  // Sent for the current week (Team: or recorded by the host), so the order controls stay locked.
  get submitted() { const role = this.role; return !!role && (!this.isClassroom && Object.hasOwn(this.pending, role) || !!this.game && this.sent?.week === this.game.week); }
  get orderStatus(): OrderStatus | null {
    const game = this.game, role = this.role, room = this.room;
    if (!game || !role || !room || this.over || this.replaced) return null;
    const week = game.week, sent = this.sent?.week === week ? this.sent : null;
    const amount = !this.isClassroom && Object.hasOwn(this.pending, role) ? this.pending[role]! : sent?.acked ? sent.amount : null;
    if (amount !== null) { // Who has submitted is public; only this player's own amount is shown.
      const waitingFor = this.isClassroom ? [] : this.activeRoles.filter(r => !this.submittedRoles.includes(r)).map(r => this.chain?.members.find(m => m.role === r)?.nickname || r);
      const next = this.hostOffline ? ' Waiting for the host to return.' : waitingFor.length ? ` Waiting for ${list(waitingFor)}.` : '';
      return { week, amount, state: 'accepted', waitingFor, message: `Accepted for week ${week}: ${amount} cases.${next}`, canRetry: false };
    }
    if (!sent) return null;
    const state = !this.connected(room.host) ? 'interrupted' : Date.now() - sent.at >= ACK_MS ? 'unconfirmed' : 'sending';
    const message = { sending: `Sending your week ${week} order (${sent.amount} cases)…`, unconfirmed: `No reply from the host yet. Send your week ${week} order (${sent.amount} cases) again.`, interrupted: `Connection interrupted. Your week ${week} order (${sent.amount} cases) is not confirmed yet.` }[state];
    return { week, amount: sent.amount, state, waitingFor: [], message, canRetry: state === 'unconfirmed' };
  }
  get hostOffline() { const room = this.room; return !!room && !this.isHost && room.members.find(m => m.id === room.host)?.online === false; }
  get online() { return this.socket?.readyState === WebSocket.OPEN; } // This browser's signaling connection.
  // Classroom monitoring: leaderboard rows by status.
  get classroomCounts() { const counts = { playing: 0, disconnected: 0, finished: 0, incomplete: 0 }; for (const row of this.leaderboard) counts[scoreStatus(row)]++; return counts; }
  connected(id: string) { return this.room?.members.find(m => m.id === id)?.online !== false && (id === this.id || this.peers.get(id)?.channel?.readyState === 'open'); }
  private hostLinks: string[] = []; // Before start, members with an open channel to the creator, as the creator reports them.
  // Start rule for a member's connection: an open channel to the creator. Guests cannot see other guests' channels, so they use the creator's report.
  linked(id: string) {
    const room = this.room;
    if (!room || this.isHost || id === room.host) return this.connected(id);
    return room.members.find(m => m.id === id)?.online !== false && (id === this.id ? this.connected(room.host) : this.hostLinks.includes(id));
  }
  memberStatus(member: Member) { return lobbyStatus(this.room!, member, id => this.linked(id)); }
  get lobbySummary() { return this.room ? lobbySummary(this.room, this.id, id => this.linked(id)) : ''; }
  get startReview() { return this.isHost && !this.room!.started ? startReview(this.room!) : []; }
  // Before start the host can remove a disconnected member, or start without them once nothing else blocks the start.
  get awayMembers() { return this.isHost && !this.room!.started ? this.room!.members.filter(m => m.online === false) : []; }
  get startWithout() {
    const away = this.awayMembers, ids = away.map(m => m.id);
    return away.length && !this.blocker(ids) ? { ids, ...startWithoutPrompt(this.room!, away) } : null;
  }
  private shareLinks() {
    if (!this.isHost || this.room!.started) return;
    const links = JSON.stringify({ type: 'links', ids: this.room!.members.filter(m => this.connected(m.id)).map(m => m.id) });
    for (const peer of this.peers.values()) if (peer.channel?.readyState === 'open') peer.channel.send(links);
  }
  private update() { this.persist(); this.revision.update(n => n + 1); this.onUpdate(); }
  private persist() {
    if (!this.room || !this.token || this.restoring) return;
    if (this.revealed) { // A run that is complete but not yet revealed keeps its save, so a refresh still receives the reveal.
      this.forgetSaved();
      if (this.isHost && !this.finishedSent) { this.sendSignal({ type: 'finished' }); this.finishedSent = true; }
      return;
    }
    const saved: SavedSession = { version: 1, token: this.token, id: this.id, room: this.room, savedAt: Date.now(), game: this.isHost ? this.game : null,
      pending: this.isHost ? this.pending : {}, challengeGames: this.isHost ? [...this.challengeGames] : [], leaderboard: this.isHost ? this.leaderboard : [], challengeStarted: this.challengeStarted, groupPending: this.isHost ? [...this.groupPending] : [] };
    try { writeSave(saved, undefined, this.openElsewhere); this.saved = saved; this.storageWarning = ''; }
    catch { this.storageWarning = 'Browser storage is unavailable or full. This session cannot be reliably resumed after refresh.'; }
  }
  // Removes this tab's session save.
  forgetSaved() { if (this.saved) this.forget(this.saved); this.saved = null; }
  forget(save: SavedSession) { removeSave(save); this.checks.delete(saveKey(save)); this.refreshSaves(); }
  dismissEnded(key: string) { this.ended = this.ended.filter(e => e.key !== key); }
  // Re-reads the saves (another tab may have added or removed one) and checks any not checked yet.
  refreshSaves() {
    this.saves = readSaves();
    for (const save of this.saves) if (!this.checks.has(saveKey(save))) void this.check(save);
  }
  // Asks the server whether a save can still be resumed. A network failure or timeout is never proof that the game ended: the save stays and Retry is offered.
  async check(save: SavedSession) {
    const key = saveKey(save);
    this.checks.set(key, 'checking');
    const answer = await this.ask(save, socket => socket.send(JSON.stringify({ type: 'check', code: save.room.code, token: save.token })), msg => msg.type === 'available');
    if (this.checks.get(key) !== 'checking') return; // Removed, resumed or ended meanwhile.
    if (answer && !answer.available && !(this.room && this.saved && saveKey(this.saved) === key)) return this.endSave(save, answer.reason);
    this.checks.set(key, answer ? 'available' : 'unverified'); this.onUpdate();
  }
  // A host's save: resume with its token, then leave, which closes the game for every player instead of leaving them waiting for 24 hours.
  async endForEveryone(save: SavedSession) {
    const key = saveKey(save);
    this.checks.set(key, 'ending');
    const answer = await this.ask(save, socket => socket.send(JSON.stringify({ type: 'resume', code: save.room.code, token: save.token })), (msg, socket) => {
      if (msg.type === 'session') socket.send(JSON.stringify({ type: 'leave' }));
      return msg.type === 'session' || msg.type === 'resume-unavailable';
    });
    if (this.checks.get(key) !== 'ending') return;
    if (answer) return this.endSave(save, answer.type === 'session' ? 'ended' : answer.reason);
    this.checks.set(key, 'unverified'); this.onUpdate();
  }
  private endSave(save: SavedSession, reason: string | undefined) {
    const key = saveKey(save);
    this.forget(save);
    this.ended = [...this.ended.filter(e => e.key !== key), { key, save, reason: endedReasons[reason ?? ''] ?? 'Ended or expired.' }];
    this.onUpdate();
  }
  // One short signaling connection: `open` sends the request, and the first message `done` accepts is the answer (null after 5 seconds or a failure).
  private ask(save: SavedSession, open: (socket: WebSocket) => void, done: (msg: any, socket: WebSocket) => boolean) {
    return new Promise<any>(resolve => {
      const socket = new WebSocket(signalingUrl());
      let answer: any = null;
      const timer = setTimeout(() => socket.close(), 5000);
      socket.onopen = () => open(socket);
      socket.onmessage = event => { const msg = JSON.parse(event.data); if (!answer && done(msg, socket)) { answer = msg; socket.close(); } };
      socket.onclose = () => { clearTimeout(timer); resolve(answer); };
      socket.onerror = () => socket.close();
    });
  }
  async resume(saved = this.saved) {
    if (!saved) return;
    await this.enter('resume', '', saved.room.code, 'network', {}, saved);
  }
  async enter(action: 'create' | 'join' | 'resume', name: string, code = '', visibility: InformationVisibility = 'network', options: { hostPlays?: boolean; kind?: Room['kind']; challenge?: ChallengeConfig | DemandConfig } = {}, saved: SavedSession | null = null) {
    const unsent = action === 'resume' && this.room?.code === code && this.sent && !this.sent.acked ? this.sent : null; // Re-sent once the channel to the host reopens.
    this.leave(false); // Other saves stay; a new game gets its own save once its session exists.
    this.restoring = saved; this.saved = saved; this.sent = unsent;
    this.error = ''; this.status = 'Connecting to supply chain…'; this.update();
    const generation = this.generation;
    try {
      this.config = await loadRtcConfig();
      if (generation !== this.generation) return;
      const socket = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/signaling`);
      this.socket = socket;
      socket.onopen = () => { if (generation === this.generation) this.sendSignal({ type: action, name, code, ...(saved ? { token: saved.token } : {}), ...(action === 'create' ? { visibility, ...options } : {}) }); };
      socket.onmessage = event => {
        if (generation !== this.generation) return;
        void this.handleSignaling(JSON.parse(event.data)).catch(() => { this.error = 'Peer connection failed. Check the network or TURN configuration.'; this.update(); });
      };
      socket.onerror = () => { if (generation === this.generation) { this.error = 'Cannot reach the signaling service.'; this.update(); } };
      socket.onclose = event => {
        if (generation !== this.generation) return;
        this.status = 'Signaling disconnected'; this.lost = event.code !== 4001;
        this.error = event.code === 4001 ? 'This session was resumed in another tab. Continue there.' : this.canReconnect ? 'Connection lost. Select Reconnect to rejoin the game.' : 'Connection lost. Refresh this page and choose Resume game to reconnect.';
        this.token = ''; this.closePeers(); this.update();
      };
    } catch (e) { if (generation === this.generation) { this.error = (e as Error).message; this.status = 'Connection failed'; this.update(); } }
  }
  setNickname(nickname: string) { this.error = ''; this.sendSignal({ type: 'nickname', nickname }); }
  // Before start a Team player can switch to any role nobody holds; the server refuses a role taken meanwhile.
  claim(role: Role) { this.error = ''; this.sendSignal({ type: 'claim', role }); }
  decide(role: Role, system: boolean, group?: string) { this.error = ''; this.sendSignal({ type: 'decide', role, system, ...(group ? { group } : {}) }); } // The group host names the group.
  // Classroom Group Challenge lobby: create a group (and join it), or join or switch to another; the server frees the old role.
  createGroup(name: string) { this.error = ''; this.sendSignal({ type: 'group-create', name }); }
  joinGroup(id: string) { this.error = ''; this.sendSignal({ type: 'group-join', group: id }); }
  remove(id: string) { this.error = ''; this.sendSignal({ type: 'remove', id }); }
  // The first reason the host cannot start yet, or '' when the lobby is ready. `without`: disconnected members the host would start without.
  private blocker(without: string[] = []) {
    const room = this.room;
    if (!room) return 'Create or join a lobby before starting a multiplayer game.';
    if (!this.isHost) return 'Only the host can start the multiplayer game.';
    if (room.started) return 'This multiplayer game has already started.';
    if (!this.nickname) return 'Enter your nickname and select Save nickname before starting.';
    const members = room.members.filter(m => !without.includes(m.id));
    if (!members.some(m => m.role)) return !this.isObserver ? 'Choose your role before starting.' : this.isGroups ? 'At least one player must join a group and choose a role before starting.' : 'At least one player must join the lobby before starting.';
    if (members.some(m => !m.nickname)) return 'Every player must enter a nickname before starting.';
    if (this.isGroups && members.some(m => !m.group && m.id !== room.host)) return 'Every player must join a group before starting.';
    if (members.some(m => !m.role && !(room.hostPlays === false && m.id === room.host))) return 'Every player must choose a role before starting.';
    if (!this.lobbyReady(members)) return 'Wait for all players to connect or resume their game before starting.';
    return '';
  }
  get startBlocker() { return this.blocker(); }
  private startTried = false;
  // Shown beside Start after an attempt, and kept current until the lobby is ready.
  get startError() { return this.startTried && !this.room?.started ? this.startBlocker : ''; }
  start(without: string[] = []) {
    this.startTried = true;
    if (!this.blocker(without)) { this.error = ''; this.sendSignal({ type: 'started', ...(without.length ? { without } : {}) }); }
    this.update();
  }
  private sendSignal(message: object) { if (this.socket?.readyState === WebSocket.OPEN) this.socket.send(JSON.stringify(message)); }
  private async handleSignaling(msg: any) {
    if (msg.type === 'welcome') this.id = msg.id;
    if (msg.type === 'session') { this.id = msg.id; this.token = msg.token; }
    if (msg.type === 'resume-unavailable') { this.restoring = null; this.forgetSaved(); this.error = msg.message; this.status = 'Saved game unavailable'; }
    if (msg.type === 'error') { const field = ({ nickname: 'nickname', join: 'code', 'group-create': 'group' } as const)[msg.request as string]; if (field) this.fieldError(field, msg.message, msg.reason ?? null); else this.error = msg.message; this.status =this.room ? this.room.started ? 'Multiplayer game' : 'Supply chain lobby' : 'Could not join supply chain'; }
    if (msg.type === 'closed') {
      this.forgetSaved();
      // Players keep their final screen after the room closes; this browser stops using the closed room.
      if (this.over) { this.closedNotice = msg.message; this.token = ''; this.generation++; this.socket?.close(); this.socket = undefined; }
      else { this.error = msg.message; this.room = null; this.game = null; this.pending = {}; this.peerSubmittedRoles = []; }
      this.closePeers(); this.status = 'Supply chain closed';
    }
    if (msg.type === 'room') {
      const previousStarted = this.room?.started;
      const previousRoom = this.room;
      this.room = { ...msg.room, visibility: msg.room.visibility ?? 'network' };
      this.handingBack = this.handingBack.filter(h => { const chain = chainView(this.room!, h.group); return chain?.automated?.[h.role] && chain.takeBack?.includes(h.role); }); // Until the server confirms or the player leaves again.
      const restoring = this.restoring;
      if (restoring && this.isHost) {
        try {
          this.game = restoreGame(restoring.game); this.pending = restoring.pending;
          this.challengeGames = new Map(restoring.challengeGames.map(([id, game]) => [id, restoreGame(game)!]));
          this.leaderboard = restoring.leaderboard; this.challengeStarted = restoring.challengeStarted; this.groupPending = new Map(restoring.groupPending ?? []);
          if (this.isClassroom) this.game = this.challengeGames.get(this.id) ?? null;
          if (this.room!.started && !this.game && !this.isObserver) throw new Error('Missing host state');
        } catch { this.leave(); this.error = 'The saved host game could not be restored. Create a new game.'; this.update(); return; }
      }
      this.restoring = null;
      for (const [id, peer] of this.peers) {
        const member = this.room!.members.find(m => m.id === id);
        if (!member || member.online === false || member.connection !== previousRoom?.members.find(m => m.id === id)?.connection) { peer.pc.close(); this.peers.delete(id); }
      }
      this.status = this.room!.started ? 'Multiplayer game' : 'Supply chain lobby';
      if (this.isHost) {
        for (const [id, peer] of this.peers) if (!this.room!.members.some(m => m.id === id)) { peer.pc.close(); this.peers.delete(id); }
        for (const member of this.room!.members) if (member.id !== this.id && member.online !== false && !this.peers.has(member.id)) await this.makePeer(member.id, true);
        if (this.room!.started && !previousStarted && !restoring && (this.role || this.isObserver)) {
          if (this.isClassroom) {
            const scenario = demandScenario(this.room!.challenge!);
            this.challengeStarted = Date.now();
            const players = this.room!.members.filter(m => m.role);
            for (const member of players) this.challengeGames.set(member.id, new BeerGame(member.role!, scenario));
            this.game = this.challengeGames.get(this.id) ?? null;
            this.leaderboard = players.map(m => ({ id: m.id, nickname: m.nickname, completedWeeks: 0, cost: 0, elapsedMs: null, finished: false, connected: true, incomplete: false }));
          } else if (this.isGroups) { // One chain per group, every one with the same seeded customer demand.
            const customer = demandScenario(this.room!.challenge!);
            this.challengeStarted = Date.now();
            for (const g of this.groups) { this.challengeGames.set(g.id, new BeerGame('Retailer', undefined, customer)); this.groupPending.set(g.id, {}); }
            this.leaderboard = this.groups.map(g => ({ id: g.id, nickname: g.name, members: ROLES.flatMap(role => this.room!.members.filter(m => m.group === g.id && m.role === role).map(m => ({ nickname: m.nickname, role }))), completedWeeks: 0, cost: 0, elapsedMs: null, finished: false, connected: true, incomplete: false }));
          } else this.game = new BeerGame(this.role!);
          this.broadcast();
        } else if (this.isChallenge && this.room!.started) { this.advancePending(); this.broadcast(); }
        else if (this.room!.started && this.advancePending()) this.broadcast(); // A decision to let the system play can complete the waiting week.
        this.shareLinks();
      }
      if (!this.errorField || this.errorField === 'nickname' && this.room!.started) this.error = ''; // Field errors stay until the player resubmits.
    }
    if (msg.type === 'signal') {
      if (!this.room || !this.room.members.some(m => m.id === msg.from)) return;
      const peer = this.peers.get(msg.from) ?? await this.makePeer(msg.from, false);
      if (msg.signal.description) {
        await peer.pc.setRemoteDescription(msg.signal.description);
        for (const candidate of peer.candidates.splice(0)) await peer.pc.addIceCandidate(candidate);
        if (msg.signal.description.type === 'offer') {
          await peer.pc.setLocalDescription(await peer.pc.createAnswer());
          this.sendSignal({ type: 'signal', to: msg.from, signal: { description: peer.pc.localDescription } });
        }
      } else if (msg.signal.candidate) {
        if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(msg.signal.candidate);
        else peer.candidates.push(msg.signal.candidate);
      }
    }
    this.update();
  }
  private async makePeer(id: string, initiator: boolean) {
    const pc = new RTCPeerConnection(this.config);
    const peer: Peer = { pc, candidates: [] };
    this.peers.set(id, peer);
    pc.onicecandidate = event => { if (event.candidate) this.sendSignal({ type: 'signal', to: id, signal: { candidate: event.candidate.toJSON() } }); };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') this.error = 'WebRTC connection failed. A TURN relay may be needed for this network.';
      this.update();
    };
    const attach = (channel: RTCDataChannel) => {
      peer.channel = channel;
      channel.onopen = () => {
        if (this.isHost) { this.advancePending(); this.broadcast(); this.shareLinks(); }
        else if (id === this.room?.host && this.sent && !this.sent.acked) this.sendOrder(); // The host answers a copy it already has with the amount it recorded.
        this.update();
      };
      channel.onclose = () => { if (this.isHost && this.isChallenge) this.broadcast(); this.shareLinks(); this.update(); };
      channel.onmessage = event => { try { this.receive(id, JSON.parse(event.data)); } catch { this.error = 'An invalid peer message was ignored.'; this.update(); } };
    };
    pc.ondatachannel = event => attach(event.channel);
    if (initiator) {
      attach(pc.createDataChannel('beer-game', { ordered: true }));
      await pc.setLocalDescription(await pc.createOffer());
      this.sendSignal({ type: 'signal', to: id, signal: { description: pc.localDescription } });
    }
    return peer;
  }
  private receive(id: string, msg: any) {
    const fromHost = !this.isHost && id === this.room?.host;
    if (this.isHost && msg.type === 'order') this.acceptOrder(id, msg.week, msg.amount);
    else if (fromHost && msg.type === 'state') this.applySnapshot(msg);
    else if (fromHost && msg.type === 'ack') this.acknowledge(msg);
    else if (fromHost && msg.type === 'leaderboard' && Array.isArray(msg.rows)) { this.leaderboard = msg.rows; this.update(); }
    else if (fromHost && msg.type === 'links' && Array.isArray(msg.ids)) { this.hostLinks = msg.ids; this.update(); }
    else if (msg.type === 'error') { this.error = msg.message; this.update(); }
  }
  submit(amount: number) {
    if (this.socket?.readyState !== WebSocket.OPEN) { this.error = this.canReconnect ? 'Connection lost. Select Reconnect before placing another order.' : 'Connection lost. Refresh this page and choose Resume game before placing another order.'; this.update(); return; }
    if (!this.game || !this.role || this.submitted || this.replaced || this.over) return;
    if (!Number.isInteger(amount) || amount < 0 || amount > 100) { this.fieldError('order', 'Order must be a whole number from 0 to 100.'); this.update(); return; }
    this.error = '';
    if (this.isHost) this.acceptOrder(this.id, this.game.week, amount);
    else {
      if (this.peers.get(this.room!.host)?.channel?.readyState !== 'open') { this.error = 'Waiting for the host’s WebRTC connection.'; this.update(); return; }
      this.sent = { week: this.game.week, amount, at: 0, acked: false };
      this.sendOrder();
    }
  }
  // Sends the unconfirmed order again, unchanged: same week, same amount.
  resend() { if (this.orderStatus?.canRetry) this.sendOrder(); }
  private sendOrder() {
    const sent = this.sent!, channel = this.peers.get(this.room!.host)?.channel;
    if (channel?.readyState !== 'open') return;
    channel.send(JSON.stringify({ type: 'order', week: sent.week, amount: sent.amount }));
    sent.at = Date.now();
    clearTimeout(this.ackTimer); this.ackTimer = setTimeout(() => this.update(), ACK_MS + 50); // Offers Send again if no reply arrives.
    this.update();
  }
  private acknowledge(msg: { week: number; accepted: boolean; amount?: number; message?: string }) {
    const sent = this.sent;
    if (!sent || msg.week !== sent.week) return;
    clearTimeout(this.ackTimer);
    if (msg.accepted) { sent.acked = true; sent.amount = msg.amount!; } // The amount the host recorded.
    else { this.sent = null; this.fieldError('order', msg.message || `Your week ${msg.week} order was not accepted.`); }
    this.update();
  }
  private sendTo(id: string, message: object) { const channel = this.peers.get(id)?.channel; if (channel?.readyState === 'open') channel.send(JSON.stringify(message)); }
  // The host records one order per role (Classroom: per run; Groups: per role of each group) per week and answers every copy, so a re-sent order never plays a week twice.
  private acceptOrder(id: string, week: number, amount: number) {
    const reply = (recorded: number | null, message = `Your week ${week} order was not accepted.`) => { if (id !== this.id) this.sendTo(id, recorded === null ? { type: 'ack', week, accepted: false, message } : { type: 'ack', week, accepted: true, amount: recorded }); };
    const valid = Number.isInteger(amount) && amount >= 0 && amount <= 100, played = (game: BeerGame, role: Role) => Number.isInteger(week) && week >= 1 && week < game.week ? game.history[week - 1].parties[ROLES.indexOf(role)].order : null;
    if (this.isClassroom) {
      const game = this.challengeGames.get(id);
      if (!game || !this.room?.members.some(m => m.id === id)) return;
      if (played(game, game.player) !== null) return reply(played(game, game.player));
      if (this.revealed || game.complete || game.week !== week || !valid) return reply(null, this.revealed ? 'The host finished the classroom.' : undefined);
      game.advance(amount);
      const row = this.leaderboard.find(r => r.id === id)!;
      row.completedWeeks = game.history.length;
      row.cost = game.current.cost;
      if (game.complete) { row.finished = true; row.cost = game.current.cost; row.elapsedMs = Math.max(0, Date.now() - this.challengeStarted); }
      this.broadcast(); this.update(); return reply(amount);
    }
    const member = this.room?.members.find(m => m.id === id), role = member?.role, chain = member ? chainView(this.room!, member.group) : null;
    const game = chain?.group ? this.challengeGames.get(chain.group) : this.game, pending = chain?.group ? this.pendingFor(chain.group) : this.pending;
    if (!game || !role || !chain) return;
    if (played(game, role) !== null) return reply(played(game, role));
    if (week === game.week && Object.hasOwn(pending, role)) return reply(pending[role]!);
    const automated = this.automatedIn(chain).includes(role), stopped = this.isGroups && this.revealed;
    if (automated || stopped || week !== game.week || game.complete || !valid) return reply(null, automated ? `The system is playing ${role} this week.` : stopped ? 'The host finished the classroom.' : undefined);
    pending[role] = amount;
    this.advancePending();
    this.broadcast(); this.update(); reply(amount);
  }
  private broadcast() {
    this.persist();
    if (!this.game && !this.isObserver) return;
    if (this.isChallenge) { // A group shows as connected while every role it waits for has a player connected to the host.
      const linked = (id: string) => { const chain = this.isGroups ? chainView(this.room!, id) : null; return chain ? this.readyIn(chain) : !this.isGroups && !!this.room?.members.some(m => m.id === id) && this.connected(id); };
      this.leaderboard = rankScores(this.leaderboard.map(row => ({ ...row, connected: linked(row.id) })));
    }
    const revealed = this.revealed, level = dataScope(this.room!.visibility, revealed);
    for (const [id, peer] of this.peers) {
      const member = this.room?.members.find(member => member.id === id), role = member?.role;
      if (!role || peer.channel?.readyState !== 'open') continue;
      // Each group member receives only their own group's chain.
      const game = this.isClassroom ? this.challengeGames.get(id) : this.isGroups ? this.challengeGames.get(member!.group ?? '') : this.game;
      if (!game) continue;
      const pending = this.isGroups ? this.pendingFor(member!.group!) : this.pending;
      const snapshot: Snapshot = { type: 'state', week: game.week, ...(game.scenario ? { scenario: game.scenario } : {}), ...(game.customer && visibleRoles(level, role).includes('Retailer') ? { customer: game.customer } : {}),
        parties: visibleParties(game.parties, level, role), history: visibleHistory(game, level, role),
        pending: visiblePending(pending, level, role), submittedRoles: this.isGroups ? Object.keys(pending) as Role[] : this.submittedRoles, ...(revealed ? { revealed } : {}) };
      peer.channel.send(JSON.stringify(snapshot));
      if (this.isChallenge) peer.channel.send(JSON.stringify({ type: 'leaderboard', rows: this.leaderboard }));
    }
  }
  private applySnapshot(snapshot: Snapshot) {
    if (!this.role || !Number.isInteger(snapshot.week) || snapshot.week < 1 || snapshot.week > 25 || !Array.isArray(snapshot.parties) || !snapshot.parties.some(p => p.role === this.role) || !Array.isArray(snapshot.history) || snapshot.history.length !== snapshot.week - 1) return;
    this.game ??= new BeerGame(this.role, snapshot.scenario, snapshot.customer); // customer: a group's seeded demand, sent only while the Retailer is in view.
    if (snapshot.week < this.game.week) return;
    const restorePositions = (parties: Party[]) => ROLES.map(role => parties.find(p => p.role === role) ?? hiddenParty(role));
    if (this.sent && (snapshot.week > this.sent.week || snapshot.revealed)) { this.sent = null; clearTimeout(this.ackTimer); } // That week is played.
    this.revealedByHost ||= snapshot.revealed === true; // The creator's final unfiltered snapshot replaces the hidden placeholders.
    this.game.week = snapshot.week; this.game.parties = restorePositions(snapshot.parties);
    this.game.history = snapshot.history.map(row => ({ ...row, demand: row.demand ?? 0, parties: restorePositions(row.parties) }));
    this.pending = snapshot.pending; this.peerSubmittedRoles = snapshot.submittedRoles ?? Object.keys(snapshot.pending) as Role[];
    this.update();
  }
  // The creator ends every unfinished run and marks it incomplete, which reveals each competitor's own run.
  finishClassroom() {
    if (!this.isHost || !this.isChallenge || !this.room?.started || this.revealed) return;
    for (const row of this.leaderboard) if (!row.finished) row.incomplete = true;
    this.broadcast(); this.update();
  }
  private closePeers() { for (const peer of this.peers.values()) peer.pc.close(); this.peers.clear(); }
  // Advances the Team game, or every group that can, once each chain's waiting roles have ordered.
  private advancePending() {
    if (this.isGroups) return this.groups.filter(g => this.advanceGroup(g.id)).length > 0;
    return !this.isClassroom && !!this.game && this.advanceIn(this.room!, this.game, this.pending);
  }
  private pendingFor(group: string) { let pending = this.groupPending.get(group); if (!pending) this.groupPending.set(group, pending = {}); return pending; }
  private advanceIn(chain: Room, game: BeerGame, pending: Partial<Record<Role, number>>) {
    const active = this.activeIn(chain);
    if (game.complete || !this.readyIn(chain) || !active.every(r => Object.hasOwn(pending, r))) return false;
    // A system-played role keeps any order its player sent before leaving.
    if (chain.group) game.advanceChain(pending); else game.advanceMultiplayer(pending, ROLES.filter(role => active.includes(role) || Object.hasOwn(pending, role)));
    for (const role of Object.keys(pending)) delete pending[role as Role];
    // Returned players play from the new week. Save the advanced engine before telling the server, so a host crash cannot hand a role back mid-week.
    const back = (chain.takeBack ?? []).filter(role => this.automatedIn(chain).includes(role));
    if (back.length) { this.handingBack.push(...back.map(role => ({ group: chain.group ?? null, role }))); this.persist(); for (const role of back) this.sendSignal({ type: 'handback', role, ...(chain.group ? { group: chain.group } : {}) }); }
    return true;
  }
  // A group advances as a Team game does and scores its total chain cost; time counts from the shared start. With every seat played by the system it plays on to the end.
  private advanceGroup(id: string) {
    const chain = chainView(this.room!, id), game = this.challengeGames.get(id), row = this.leaderboard.find(r => r.id === id);
    if (!chain || !game || !row || this.revealed) return false;
    let advanced = false;
    while (this.advanceIn(chain, game, this.pendingFor(id))) {
      advanced = true; row.completedWeeks = game.history.length; row.cost = game.totalCost;
      if (game.complete) { row.finished = true; row.elapsedMs = Math.max(0, Date.now() - this.challengeStarted); }
      if (this.activeIn(chain).length) break;
    }
    return advanced;
  }
  leave(explicit = true) {
    // Without a room, the save belongs to another game. A Team guest leaving a started game keeps their seat and save.
    if (explicit) { this.sendSignal({ type: 'leave' }); if (this.room && (this.isHost || this.isClassroom || !this.room.started)) this.forgetSaved(); }
    this.generation++;
    this.socket?.close(); this.socket = undefined; this.closePeers();
    this.challengeGames.clear(); this.groupPending.clear(); this.leaderboard = []; this.challengeStarted = 0; this.sent = null; clearTimeout(this.ackTimer);
    this.room = null; this.game = null; this.pending = {}; this.peerSubmittedRoles = []; this.id = ''; this.error = ''; this.status = 'Not connected';
    this.token = ''; this.restoring = null; this.finishedSent = false; this.handingBack = []; this.hostLinks = []; this.lost = false; this.startTried = false; this.revealedByHost = false; this.closedNotice = '';
    this.refreshSaves(); // The game just left may still be resumable.
  }
}
