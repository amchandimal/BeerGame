import { ChangeDetectorRef, Component, Injector, ViewChild, afterNextRender, inject } from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { BeerGame, ROLES, Role, WEEKS } from './game';
import { SupplySceneComponent } from './supply-scene';
import { ChallengeConfig, DEMAND_METHODS, DemandConfig, ScoreStatus, randomDemand, singleGame } from './challenge';
import { MultiplayerSession, Room, SaveCheck } from './multiplayer';
import { createGameAgent } from './game-agent';
import { InformationVisibility, VISIBILITY_OPTIONS, dataScope, visibleRoles, visibleCsv } from './visibility';
import { debrief, resultsFilename, scenarioLabel } from './debrief';
import { joinCode, methodLabel } from './lobby';
import { MAX_SAVES, SINGLE_KEY, SavedSession, SingleSave, TabPresence, changesSaves, readSingle, saveKey, tabHadSingle, writeSingle } from './saves';
import { NavigationEnd, Router, RouterLink, RouterOutlet } from '@angular/router';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { LeaderboardComponent } from './leaderboard';
import { CardOption, CardPickerComponent } from './card-picker';
import { InvitationComponent } from './invitation';
import { LobbyRosterComponent } from './lobby-roster';
import { ConnectionNoticeComponent } from './connection-notice';

// A row of Your games: a multiplayer save, the single-player save, or a save that has ended (listed with the reason until dismissed).
interface SavedGame { key: string; name: string; detail: string; state: SaveCheck | 'open' | 'single' | 'ended'; save?: SavedSession; host?: boolean; reason?: string; }

@Component({
  selector: 'app-root', standalone: true, imports: [CommonModule, FormsModule, SupplySceneComponent, RouterLink, RouterOutlet, LeaderboardComponent, CardPickerComponent, InvitationComponent, LobbyRosterComponent, ConnectionNoticeComponent],
  templateUrl: './app.html'
})
export class AppComponent {
  private cdr = inject(ChangeDetectorRef);
  private router = inject(Router);
  private injector = inject(Injector);
  readonly year = new Date().getFullYear();
  routePath = location.pathname;
  private routed = false; // The first navigation is the page load, which keeps the browser's own focus.
  away = false;
  // After a route change, focus moves to the new view's heading (or the Game in progress bar) so keyboard and screen-reader users start there.
  private focusHeading() { afterNextRender(() => document.querySelector<HTMLElement>('main h1, main .session-bar')?.focus(), { injector: this.injector }); }
  skipToMain(event: Event) { event.preventDefault(); document.getElementById('main')?.focus(); }
  navigate(path: string) { return this.router.navigateByUrl(path); }
  private applyRoute(path: string) {
    const moved = this.routePath !== path && this.routed;
    this.routePath = path; this.routed = true;
    if (location.hash === '#agent') return;
    if (moved) this.focusHeading();
    // Navigation never ends a session; other setup routes show a return bar until an explicit exit.
    const mode = path.startsWith('/multiplayer') ? 'multi' : path === '/single-player' ? 'single' : null;
    this.away = this.live && mode !== this.mode;
    if (!this.away) this.mode = mode;
    this.multiAction = path.endsWith('/create') ? 'kind' : /\/join(?:\/\d{6})?$/.test(path) ? 'join' : /\/(team-supply-chain|classroom-challenge|classroom-group-challenge)$/.test(path) ? 'create' : 'choose';
    const invite = path.match(/^\/multiplayer\/join\/(\d{6})$/);
    if (invite) this.chainCode = invite[1];
    if (path.endsWith('/classroom-challenge')) this.gameKind = 'classroom';
    if (path.endsWith('/classroom-group-challenge')) this.gameKind = 'groups';
    if (path.endsWith('/team-supply-chain')) this.gameKind = 'team';
    this.formError = null;
    const titles: Record<string,string> = { '/':'Beer Game Online', '/single-player':'Single Player', '/multiplayer':'Multiplayer', '/multiplayer/create':'Create a Game', '/multiplayer/join':'Join a Game', '/multiplayer/team-supply-chain':'Team Supply Chain', '/multiplayer/classroom-challenge':'Classroom Individual Challenge', '/multiplayer/classroom-group-challenge':'Classroom Group Challenge' };
    document.title = `${titles[path] ?? (invite ? 'Join a Game' : 'Beer Game')} | beergame.io`; // Matches the server's title for invitation links.
    const canonical = document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (canonical) canonical.href = new URL(path, canonical.href).href;
    this.cdr.markForCheck();
  }
  mode: 'single' | 'multi' | null = null;
  visibility: InformationVisibility = 'network';
  visibilityOptions = VISIBILITY_OPTIONS;
  get activeVisibility() { return this.mode === 'multi' ? this.multi.room?.visibility ?? this.visibility : this.visibility; }
  get visibilityInfo() { return VISIBILITY_OPTIONS.find(option => option.value === this.activeVisibility)!; }
  // Hidden information is revealed once the game is over (Classroom: once every run is over); the chosen level still labels the game.
  get revealed() { return this.mode === 'multi' ? this.multi.revealed : !!this.game?.complete; }
  get dataVisibility() { return dataScope(this.activeVisibility, this.revealed); }
  get visibleRoles() { const role = this.game?.player ?? this.selected; return role ? visibleRoles(this.dataVisibility, role) : []; }
  // Roles hidden during play whose values are now shown, labelled "Revealed after the game".
  get revealedRoles() { const role = this.game?.player; return role && this.revealed ? ROLES.filter(r => !visibleRoles(this.activeVisibility, role).includes(r)) : []; }
  get revealedNote() {
    const roles = this.revealedRoles;
    return roles.length ? `Revealed after the game: ${[...roles, ...roles.includes('Retailer') ? ['customer demand'] : [], 'team cost'].join(', ').replace(/, ([^,]+)$/, ' and $1')}.` : '';
  }
  canSee(role: Role) { return this.visibleRoles.includes(role); }
  get visibleRoleCount() { const n = this.visibleRoles.length; return n === ROLES.length ? `all ${n} roles visible` : n === 1 ? 'only your role visible' : `${n} of ${ROLES.length} roles visible`; }
  multiAction: 'choose' | 'create' | 'join' | 'kind' = 'choose';
  gameKind: Room['kind'] = 'team';
  readonly kindNames: Record<Room['kind'], string> = { team: 'Team Supply Chain', classroom: 'Classroom Individual Challenge', groups: 'Classroom Group Challenge' };
  challenge: ChallengeConfig = { role: 'Retailer', seed: 42, method: 'sma' };
  demandMethods = DEMAND_METHODS;
  readonly participationOptions: CardOption<boolean>[] = [{ value: true, label: 'Play and host' }, { value: false, label: 'Host only', description: 'Watch the live leaderboard.' }];
  nickname = '';
  hostPlays = true;
  chooseKind(kind: Room['kind']) { void this.navigate(`/multiplayer/${{ team: 'team-supply-chain', classroom: 'classroom-challenge', groups: 'classroom-group-challenge' }[kind]}`); }
  // Typed or pasted codes such as "295 384", or an invitation link to this site, become the six-digit code; leading zeros stay.
  setCode(value: string) { this.chainCode = joinCode(value, location.host) ?? value; }
  private readonly codeMessage = 'Enter the six-digit code or paste the invitation link.';
  async joinByCode() { if (this.invalid('homeCode', !joinCode(this.chainCode, location.host) && this.codeMessage)) return; await this.navigate('/multiplayer/join'); await this.connectRoom(); }
  readonly methodLabel = methodLabel;
  // Multiplayer create flow: game type, settings, then the lobby where the host invites players and starts.
  readonly setupSteps = ['Game type', 'Settings', 'Invite and start'];
  get setupStep() {
    const room = this.multi.room;
    if (this.multi.reconnecting) return null;
    return room ? this.multi.isHost && !room.started ? 2 : null : this.multiAction === 'kind' ? 0 : this.multiAction === 'create' ? 1 : null;
  }
  // Local validation before any connection; the message shows beside its field, which receives focus.
  formError: { field: 'homeCode' | 'chainCode' | 'chainName' | 'groupName'; message: string } | null = null;
  private invalid(field: 'homeCode' | 'chainCode' | 'chainName' | 'groupName', message: string | false) {
    this.formError = message ? { field, message } : null;
    if (message) this.focusField('#' + field);
    return !!message;
  }
  get codeError() { return this.formError?.field === 'chainCode' ? this.formError.message : this.multi.errorField === 'code' ? this.multi.error : ''; }
  // Classroom Group Challenge lobby: a new group's name (unique in the room; the server checks), the groups' members, and joining or switching.
  groupName = '';
  get groupError() { return this.formError?.field === 'groupName' ? this.formError.message : this.multi.errorField === 'group' ? this.multi.error : ''; }
  createGroup() { if (!this.invalid('groupName', !this.groupName.trim() && 'Enter a group name.')) this.multi.createGroup(this.groupName.trim()); }
  groupMembers(id: string) { return this.multi.room?.members.filter(m => m.group === id) ?? []; }
  groupLabel(id: string | undefined) { return this.multi.groups.find(g => g.id === id)?.name ?? ''; }
  private focusField(selector: string) { if (!selector) return; this.cdr.detectChanges(); document.querySelector<HTMLElement>(selector)?.focus(); }
  private focusedErrors = 0;
  chainName = '';
  chainCode = '';
  multi = new MultiplayerSession(() => this.syncMultiplayer());
  // Your games: multiplayer saves, this browser's unfinished single-player game, and which of them another tab has open.
  private tabs = new TabPresence(() => [...this.multi.saved && (this.multi.room || this.multi.reconnecting) ? [saveKey(this.multi.saved)] : [], ...this.mode === 'single' && this.game ? [SINGLE_KEY] : []], () => this.cdr.markForCheck());
  single = readSingle();
  readonly maxSaves = MAX_SAVES;
  get savedGames(): SavedGame[] {
    const multi = this.multi, rows: SavedGame[] = multi.saves.map(save => {
      const key = saveKey(save), host = save.room.host === save.id;
      return { key, save, host, name: save.room.name, detail: `${save.room.code} · ${({ team: 'Team', classroom: 'Classroom', groups: 'Groups' } as const)[save.room.kind] ?? 'Team'} · ${host ? 'Host' : 'Player'}`, state: this.tabs.openElsewhere(key) ? 'open' : multi.saveCheck(save) ?? 'checking' };
    });
    const single = this.mode === 'single' && this.game ? null : this.single; // Not this tab's own game.
    if (single) rows.unshift({ key: SINGLE_KEY, name: 'Single player', detail: `${single.game.player} · Week ${single.game.week} of ${WEEKS}`, state: this.tabs.openElsewhere(SINGLE_KEY) ? 'open' : 'single' });
    return [...rows, ...multi.ended.map(e => ({ key: e.key, name: e.save.room.name, detail: e.save.room.code, state: 'ended' as const, reason: e.reason }))];
  }
  resumableSave(code: string) { return this.multi.saves.find(s => s.room.code === code && !this.tabs.openElsewhere(saveKey(s))) ?? null; }
  resumeSaved(row: SavedGame) { return row.save ? this.resumeGame(row.save) : this.resumeSingle(); }
  removeSaved(row: SavedGame) {
    if (!row.save) { if (confirm(`Discard your week-${this.single!.game.week} game?`)) { writeSingle(null, 'network'); this.single = null; } return; }
    if (!row.host || confirm(`Remove ${row.name} without ending it? Its players wait until it expires in 24 hours.`)) this.multi.forget(row.save);
  }
  endForEveryone(save: SavedSession) { if (confirm(`End ${save.room.name} · ${save.room.code} for everyone?`)) void this.multi.endForEveryone(save); }
  // A single-player game is saved after each week; a refresh of this tab restores it, and other tabs list it under Your games.
  private saveSingle() { writeSingle(this.game, this.visibility, this.demand); this.single = readSingle(); this.tabs.update(); }
  private restoreSingle(save: SingleSave) { this.mode = 'single'; this.visibility = save.visibility; this.selected = save.game.player; this.game = save.game; this.demand = save.demand ?? null; this.order = 4; this.error = ''; }
  async resumeSingle() {
    const save = readSingle();
    if (!save) { this.single = null; return; }
    if (this.live) { if (!this.confirmExit()) return; this.clearSession(); }
    this.restoreSingle(save); this.saveSingle();
    await this.navigate('/single-player');
  }
  @ViewChild(SupplySceneComponent) scene?: SupplySceneComponent;
  roles = ROLES;
  // On-demand help (ⓘ, closed by default): what each role does and what the numbers mean. Rules only: no hidden data, no ordering advice.
  readonly roleHelp: Record<Role, string> = { Retailer: 'Sells to customers and orders from the Wholesaler.', Wholesaler: 'Supplies the Retailer and orders from the Distributor.', Distributor: 'Supplies the Wholesaler and orders from the Manufacturer.', Manufacturer: 'Supplies the Distributor and brews the beer, which takes two weeks.' };
  help: string | null = null; // The open explanation.
  toggleHelp(key: string) { this.help = this.help === key ? null : key; }
  get metricHelp() {
    const role = this.game!.player, i = ROLES.indexOf(role), owed = 'Backlog, the cases you still owe from earlier weeks, comes on top of it.';
    return {
      demand: role === 'Retailer' ? `What customers order this week. ${owed}` : `The ${ROLES[i - 1]}'s order that reaches you this week. ${owed}`,
      costs: 'Charged at the end of each week: $0.50 per case in stock and $1.00 per case of backlog. Shown for the last completed week.',
      backlog: 'Cases ordered from you that you could not ship yet. They ship first when stock arrives, and each costs $1.00 a week until then.',
      transit: role === 'Manufacturer' ? 'Beer being brewed. Brewing takes two weeks; each line shows the week it is ready.' : `Shipments on their way from the ${ROLES[i + 1]}. Delivery takes two weeks; each line shows the week the cases arrive.`
    };
  }
  icons = ['▤', '▦', '⇄', '⚙'];
  selected: Role | null = null;
  game: BeerGame | null = null;
  // Single Player customer demand: a random scenario each game (null: the classic 4 → 8), kept hidden until the game is over.
  demand: DemandConfig | null = null;
  readonly scenarioLabel = scenarioLabel;
  order = 4;
  error = '';
  showRules = false;
  weeks = WEEKS;
  constructor() {
    this.multi.openElsewhere = key => this.tabs.openElsewhere(key);
    this.multi.refreshSaves();
    if (this.single && tabHadSingle() && location.hash !== '#agent') { this.restoreSingle(this.single); this.tabs.update(); } // This tab was playing it before the refresh.
    addEventListener('storage', event => { if (changesSaves(event)) { this.multi.refreshSaves(); this.single = readSingle(); this.cdr.markForCheck(); } });
    this.router.events.pipe(takeUntilDestroyed()).subscribe(event => { if (event instanceof NavigationEnd) this.applyRoute(event.urlAfterRedirects.split(/[?#]/)[0]); });
    if (location.hash === '#agent') {
      Object.defineProperty(window, 'beerGameAgent', { value: createGameAgent(this, () => this.cdr.detectChanges()), configurable: false });
    }
    if (location.hash.startsWith('#join?')) {
      const params = new URLSearchParams(location.hash.slice(6));
      this.chainName = (params.get('name') || '').slice(0, 60);
      this.chainCode = (params.get('code') || '').slice(0, 20);
      this.mode = 'multi'; this.multiAction = 'join';
      void this.router.navigateByUrl('/multiplayer/join', { replaceUrl: true });
    }
  }
  get inviteUrl() {
    if (!this.multi.room) return '';
    return `${location.origin}/multiplayer/join/${this.multi.room.code}`;
  }
  async resumeGame(save: SavedSession) { if (this.live) { if (!this.confirmExit()) return; this.clearSession(); } await this.navigate('/multiplayer'); this.mode = 'multi'; await this.multi.resume(save); }
  async connectRoom() {
    if (this.multiAction === 'create' ? this.invalid('chainName', !this.chainName.trim() && 'Enter a game name.') : this.invalid('chainCode', !joinCode(this.chainCode, location.host) && this.codeMessage)) return;
    if (this.multiAction !== 'create') this.chainCode = joinCode(this.chainCode, location.host)!;
    // A group challenge shares the demand scenario, not a role, and its host hosts only.
    await this.multi.enter(this.multiAction === 'create' ? 'create' : 'join', this.chainName, this.chainCode, this.visibility, { hostPlays: this.gameKind === 'classroom' ? this.hostPlays : this.gameKind === 'team', kind: this.gameKind, challenge: this.gameKind === 'groups' ? { seed: this.challenge.seed, method: this.challenge.method } : this.challenge }); }
  // The holder of a role in this player's chain (Team lobby, or their group).
  roleOwner(role: Role) { return this.multi.chain?.members.find(m => m.role === role); }
  // Taken roles stay focusable (aria-disabled) so their owner can be read; choosing one does nothing.
  chooseRole(role: Role) { if (!this.roleOwner(role)) this.multi.claim(role); }
  // Listed only once nobody in the Team lobby (or this player's group) is still choosing, so the list is what starting now would automate.
  get unclaimedRoles() { const room = this.multi.room, chain = this.multi.chain; return room && chain && !room.started && !this.multi.isClassroom && chain.members.every(m => m.role) ? this.multi.systemRoles : []; }
  private syncMultiplayer() {
    if (this.mode === 'multi') {
      this.game = this.multi.game;
      this.selected = this.multi.role;
      if (this.multi.nickname && !this.nickname) this.nickname = this.multi.nickname;
      const sent = this.multi.orderStatus;
      if (sent) this.order = sent.amount; // The locked field shows the amount sent, or the host's record after a refresh.
      if (this.groupName && this.multi.group?.name.toLowerCase() === this.groupName.trim().toLowerCase()) this.groupName = ''; // Created.
    }
    if (this.multi.errorField && this.multi.fieldErrors !== this.focusedErrors) setTimeout(() => this.focusField({ code: '#chainCode', nickname: '#nickname', order: '#order', group: '#groupName' }[this.multi.errorField!] ?? ''));
    this.focusedErrors = this.multi.fieldErrors;
    if (this.away && !this.live) this.applyRoute(this.routePath); // The session ended while another route was open.
    this.tabs.update();
    this.cdr.markForCheck();
  }
  // MCP can pass a scenario to reproduce a game, or 'standard' for the classic demand.
  start(demand: DemandConfig | 'standard' = randomDemand()) { if (this.selected) { this.demand = demand === 'standard' ? null : demand; this.game = singleGame(this.selected, this.demand); this.order = 4; this.error = ''; this.saveSingle(); } }
  startMultiplayer() { this.multi.start(); if (this.multi.startError) this.focusField(!this.multi.nickname ? '#nickname' : !this.multi.role && !this.multi.isChallenge ? '.lobby-roles .role-card:not([aria-disabled])' : ''); }
  get orderLocked() { return this.mode === 'multi' && (this.multi.submitted || this.multi.replaced); }
  get orderError() { return this.error || (this.mode === 'multi' && this.multi.errorField === 'order' ? this.multi.error : ''); }
  // Why the order controls are locked, shown under the field in place of its range hint.
  get orderHint() {
    const status = this.multi.orderStatus, game = this.game!;
    if (!this.orderLocked) return 'Whole cases · 0–100';
    if (status && status.state !== 'accepted') return 'Locked until confirmed';
    return game.week < WEEKS ? `Locked until week ${game.week + 1}` : 'Locked until the final week is played';
  }
  get orderButton() {
    const multi = this.multi, status = multi.orderStatus;
    if (this.mode !== 'multi') return 'Play this week';
    if (multi.replaced) return 'System plays this week';
    if (status) return { sending: 'Sending…', unconfirmed: 'Send again', interrupted: 'Not confirmed', accepted: 'Order accepted' }[status.state];
    return multi.submitted ? 'Order accepted' : multi.isClassroom ? 'Play this week' : 'Send my order';
  }
  adjustOrder(change: number) { this.order = Math.max(0, Math.min(100, Math.round(Number(this.order) || 0) + change)); }
  advance() {
    if (this.mode === 'multi') { if (this.multi.orderStatus?.canRetry) this.multi.resend(); else this.multi.submit(this.order); return; }
    try { this.game?.advance(this.order); this.error = ''; this.saveSingle(); } catch (e) { this.error = (e as Error).message; this.focusField('#order'); }
  }
  // One concise announcement per week, in place of live demand, recap and board captions.
  get weekStatus() {
    const game = this.game!, done = game.history.length;
    if (this.over) return game.complete ? `Week ${done} complete. The game is over.` : `The classroom finished after week ${done}.`;
    return `${done ? `Week ${done} complete. ` : ''}Week ${game.week} demand: ${game.currentDemand} cases.`;
  }
  // Team status chips: a departed or disconnected player is not shown as choosing.
  turnStatus(role: Role) {
    const multi = this.multi, away = multi.absences.find(a => a.role === role)?.state;
    if (this.game?.complete) return 'Finished ✓';
    if (!multi.isHumanRole(role)) return 'Auto';
    if (multi.hasSubmitted(role)) return 'Ready ✓';
    if (role === multi.role && multi.orderStatus) return 'Sending…';
    return away === 'disconnected' ? 'Disconnected' : away === 'left' || away === 'waiting' ? 'Left' : away === 'connecting' ? 'Connecting…' : 'Choosing…';
  }
  // Classroom leaderboard find and filter, kept here so they survive switching views.
  playerSearch = '';
  statusFilter: ScoreStatus | '' = '';
  private clearSession() { if (this.mode === 'single' && this.game) writeSingle(null, this.visibility); this.multi.leave(); this.mode = null; this.away = false; this.multiAction = 'choose'; this.game = null; this.demand = null; this.selected = null; this.order = 4; this.error = ''; this.nickname = ''; this.single = readSingle(); this.tabs.update(); }
  reset() { this.clearSession(); void this.navigate('/'); }
  get live() { return !!(this.game || this.multi.room || this.multi.status === 'Connecting to supply chain…'); }
  // A run is over once complete, or when the creator finished the classroom before it was.
  get over() { return !!this.game && (this.mode === 'multi' ? this.multi.over : this.game.complete); }
  // Classroom players who finished before the others still see only their visible roles.
  get awaitingReveal() { return this.over && this.dataVisibility !== 'network'; }
  get sessionComplete() { return this.multi.isChallenge && this.multi.isHost ? this.multi.revealed : this.over; }
  get exitPrompt() {
    const multi = this.multi, room = multi.room;
    if (this.sessionComplete) return '';
    if (this.mode !== 'multi') return this.game ? `Discard your week-${this.game.week} game?` : '';
    if (!room) return '';
    if (multi.isHost && multi.isChallenge) {
      const playing = room.started ? multi.leaderboard.filter(r => !r.finished && r.id !== multi.id).length : room.members.length - 1, unit = room.started && multi.isGroups ? 'group' : 'player';
      return room.started || playing ? `Close the classroom? ${playing} ${unit}${playing === 1 ? ' is' : 's are'} still playing.` : '';
    }
    if (multi.isHost) return room.started || room.members.length > 1 ? 'End the game for everyone?' : '';
    return room.started && !multi.isClassroom ? 'Leave this game? Play pauses until you return or the host lets the system play your role.' : '';
  }
  private confirmExit() { return !this.exitPrompt || confirm(this.exitPrompt); }
  exit() { if (this.confirmExit()) this.reset(); }
  finishClassroom() {
    const unfinished = this.multi.leaderboard.filter(r => !r.finished).length, unit = this.multi.isGroups ? 'group' : 'run';
    if (confirm(`Finish the classroom? ${unfinished} unfinished ${unit}${unfinished === 1 ? '' : 's'} will stop and be marked incomplete.`)) this.multi.finishClassroom();
  }
  endGame() { if (this.confirmExit()) { this.clearSession(); this.applyRoute(this.routePath); this.focusHeading(); } }
  returnToGame() { void this.navigate(this.mode === 'single' ? '/single-player' : '/multiplayer'); }
  // Narrow layouts place the board below the stats; jump to it (opening it if collapsed) without changing the URL.
  watchBoard(event: Event) {
    event.preventDefault();
    if (this.scene) { this.scene.open = true; this.cdr.detectChanges(); } // Expand before scrolling so the target position is final.
    const board = document.getElementById('supply-board');
    board?.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
    board?.focus({ preventScroll: true });
  }
  metricChange(metric: 'inventory' | 'backlog' | 'cost') {
    if (!this.game || !this.game.history.length) return 0;
    const index = ROLES.indexOf(this.game.player);
    const previous = this.game.history.at(-2)?.parties[index][metric] ?? (metric === 'inventory' ? 12 : 0);
    return this.game.current[metric] - previous;
  }
  signedChange(metric: 'inventory' | 'backlog') {
    const change = this.metricChange(metric);
    return change ? `${change < 0 ? '−' : '+'}${Math.abs(change)} cases` : 'No change';
  }
  get comparisonLabel() {
    const completedWeeks = this.game?.history.length ?? 0;
    return completedWeeks > 1 ? `vs week ${completedWeeks - 1}` : 'vs starting values';
  }
  export() {
    if (!this.game) return;
    const url = URL.createObjectURL(new Blob([visibleCsv(this.game, this.dataVisibility, this.game.player)], { type: 'text/csv;charset=utf-8' }));
    const a = document.createElement('a'); a.href = url; a.download = resultsFilename(this.game.player, this.mode === 'multi' ? this.multi.room : this.demand && !this.game.complete ? 'single-player' : this.demand); a.click(); URL.revokeObjectURL(url);
  }
  // The debrief needs the whole chain, so it waits for the reveal.
  get debrief() { return this.over && this.dataVisibility === 'network' ? debrief(this.game!) : null; }
  // Bullwhip chart: customer demand and each role's weekly orders on one scale. Dash patterns and marker shapes identify roles as well as colour.
  readonly bullwhipStyles = [
    { label: 'Customer demand', color: '#263e34', width: 3, dash: null, marker: null },
    { label: 'Retailer', color: '#2a78d6', width: 2, dash: null, marker: 'circle' },
    { label: 'Wholesaler', color: '#d95926', width: 2, dash: '8 4', marker: 'square' },
    { label: 'Distributor', color: '#199e70', width: 2, dash: '2 3', marker: 'triangle' },
    { label: 'Manufacturer', color: '#6b3fa0', width: 2, dash: '10 3 2 3', marker: 'diamond' }];
  get bullwhip() {
    const history = this.game?.history ?? [], values = [history.map(r => r.demand), ...ROLES.map((_, i) => history.map(r => r.parties[i].order))];
    const max = Math.ceil(Math.max(8, ...values.flat()) / 4) * 4;
    return { max, series: this.bullwhipStyles.map((style, s) => {
      const points = values[s].map((v, i) => ({ x: 12 + i * 576 / Math.max(1, history.length - 1), y: 252 - v / max * 244 }));
      return { ...style, points, line: points.map(p => `${p.x},${p.y}`).join(' ') };
    }) };
  }
  // Weekly trends on one value axis in cases. Series differ by colour, dash pattern and marker shape (colours validated for colour-vision deficiency).
  readonly trendStyles = [
    { key: 'inventory', label: 'Inventory', color: '#2a78d6', dash: null, marker: 'circle' },
    { key: 'backlog', label: 'Backlog', color: '#d95926', dash: '8 4', marker: 'square' },
    { key: 'order', label: 'Orders', color: '#6b3fa0', dash: '2 3', marker: 'triangle' }] as const;
  get trend() {
    const index = ROLES.indexOf(this.game!.player), history = this.game!.history;
    const max = Math.ceil(Math.max(16, ...history.flatMap(r => this.trendStyles.map(s => r.parties[index][s.key]))) / 4) * 4;
    return { max, series: this.trendStyles.map(style => {
      const points = history.map((r, i) => ({ x: 20 + i * 660 / 23, y: 172 - r.parties[index][style.key] / max * 164 }));
      return { ...style, points, line: points.map(p => `${p.x},${p.y}`).join(' ') };
    }) };
  }
}
