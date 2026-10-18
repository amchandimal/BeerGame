import { ChallengeConfig, DEMAND_METHODS, DemandConfig } from './challenge';
import { BeerGame, ROLES, Role, WEEKS } from './game';
import { type MultiplayerSession, type Room, chainView } from './multiplayer';
import { InformationVisibility, VISIBILITY_LEVELS, dataScope, visibleRoles, visibleParties, visiblePending, visibleHistory, visibleCsv } from './visibility';
import { debrief, resultsFilename, scenarioLabel } from './debrief';

interface AgentApp {
  mode: 'single' | 'multi' | null;
  selected: Role | null;
  game: BeerGame | null;
  demand: DemandConfig | null; // Single Player scenario; null is the classic demand.
  multi: MultiplayerSession;
  order: number;
  error: string;
  inviteUrl: string;
  visibility?: InformationVisibility;
  reset(): void;
  start(demand?: DemandConfig | 'standard'): void;
}
export interface AgentCommand {
  type: 'single' | 'create' | 'join' | 'start' | 'order' | 'state' | 'history' | 'export' | 'wait' | 'leave' | 'decide' | 'finish' | 'role' | 'remove' | 'createGroup' | 'joinGroup';
  role?: Role;
  name?: string;
  code?: string;
  amount?: number;
  week?: number;
  afterWeek?: number;
  timeoutMs?: number;
  visibility?: InformationVisibility;
  kind?: Room['kind'];
  challenge?: Partial<ChallengeConfig>;
  nickname?: string;
  hostPlays?: boolean;
  systemPlays?: boolean;
  withoutDisconnected?: boolean;
  playerId?: string;
  groupName?: string; // createGroup
  group?: string; // joinGroup: a group's id or name; decide: the group (Classroom Group Challenge host)
  demand?: DemandConfig | 'standard'; // single: reproduce a scenario, or the classic 4 → 8; random when omitted
}

// Opt-in API for dedicated MCP-owned pages. Uses the same engine and RTC session as the UI.
export function createGameAgent(app: AgentApp, refresh: () => void) {
  const level = () => (app.mode === 'multi' ? app.multi.room?.visibility : app.visibility) ?? 'network';
  // After the game every output shows the full chain, exactly as the UI does.
  const revealed = () => app.mode === 'multi' ? app.multi.revealed : !!app.game?.complete;
  const scope = () => dataScope(level(), revealed());
  const over = (game: BeerGame | null) => !!game?.complete || app.mode === 'multi' && app.multi.over; // Classroom runs can also stop early.
  const connectedForPlay = () => app.multi.isClassroom ? app.multi.canPlay : app.multi.isHost ? app.multi.ready : !!app.multi.room &&
    app.multi.connected(app.multi.room.host) && app.multi.activeRoles.every(role => app.multi.chain?.members.some(m => m.role === role));
  const state = () => {
    const game = app.mode === 'multi' ? app.multi.game : app.game;
    const multi = app.multi;
    const role = game?.player ?? app.selected;
    const allowed = role ? visibleRoles(scope(), role) : [];
    return {
      mode: app.mode, role: app.selected, phase: multi.isObserver && multi.room?.started ? 'observing' : game ? over(game) ? 'complete' : 'playing' : multi.room ? 'lobby' : 'idle',
      isObserver: !!multi.isObserver,
      week: game?.week ?? null, completedWeeks: game?.history.length ?? 0, totalWeeks: WEEKS,
      complete: game?.complete ?? false, teamCost: scope() === 'network' ? game?.totalCost ?? 0 : null,
      visibility: level(), visibleRoles: allowed, revealed: revealed(), revealedRoles: role && revealed() ? ROLES.filter(r => !visibleRoles(level(), role).includes(r)) : [],
      gameKind: app.mode === 'multi' ? multi.room?.kind ?? 'team' : 'single',
      // Single Player demand, named only once the game is complete, as in the UI.
      demandScenario: app.mode === 'single' && game?.complete ? { method: app.demand?.method ?? 'standard', seed: app.demand?.seed ?? null, label: scenarioLabel(app.demand) } : null,
      weeklyCosts: game?.weeklyCosts ?? null,
      leaderboard: app.mode === 'multi' && multi.isChallenge ? multi.leaderboard : [],
      classroomCounts: app.mode === 'multi' && multi.isChallenge && multi.room?.started ? multi.classroomCounts : null,
      // Classroom Group Challenge: every group with its members and free places, and this player's group.
      groups: app.mode === 'multi' && multi.room && multi.isGroups ? multi.groups.map(g => { const members = multi.room!.members.filter(m => m.group === g.id).map(m => ({ id: m.id, nickname: m.nickname, role: m.role })); return { id: g.id, name: g.name, members, freePlaces: Math.max(0, 4 - members.length), isMine: g.id === multi.group?.id }; }) : [],
      group: app.mode === 'multi' && multi.group ? { id: multi.group.id, name: multi.group.name } : null,
      currentDemand: game && !over(game) ? {
        week: game.week, quantity: game.currentDemand, unit: 'cases', label: game.demandLabel,
        source: game.player === 'Retailer' ? 'Customers' : ROLES[ROLES.indexOf(game.player) - 1],
        orderLeadTimeWeeks: game.player === 'Retailer' ? 0 : 1, includesBacklog: false
      } : null,
      canStart: app.mode === 'multi' && multi.isHost && multi.ready && !multi.room?.started,
      canOrder: !!game && !over(game) && (app.mode !== 'multi' || connectedForPlay() && !multi.submitted && !multi.replaced),
      submitted: app.mode === 'multi' && multi.submitted,
      // The same acknowledgement the UI shows beside the order button: sending, unconfirmed (canRetry), interrupted or accepted.
      orderStatus: app.mode === 'multi' ? multi.orderStatus ?? null : null,
      pendingOrders: app.mode === 'multi' && role ? visiblePending(multi.pending, scope(), role) : {},
      submittedRoles: app.mode === 'multi' ? multi.submittedRoles ?? Object.keys(multi.pending) : [],
      waitingFor: app.mode === 'multi' && !multi.isClassroom && game && !game.complete ? multi.activeRoles.filter(r => !(multi.submittedRoles ?? Object.keys(multi.pending)).includes(r)) : [],
      absentPlayers: app.mode === 'multi' ? multi.absences : [],
      systemRoles: app.mode === 'multi' ? multi.systemRoles : ROLES.filter(r => r !== app.selected),
      room: app.mode === 'multi' && multi.room ? { ...multi.room, isCreator: multi.isHost, members: multi.room.members.map(m => ({ ...m, connectedToThisPlayer: multi.connected(m.id), status: multi.memberStatus(m), canRemove: multi.awayMembers.includes(m) })), invitationUrl: app.inviteUrl } : null,
      lobbySummary: app.mode === 'multi' && multi.room && !multi.room.started ? multi.lobbySummary : null,
      // Host before start: the same review and start-without prompt the UI shows beside Start.
      startReview: app.mode === 'multi' && multi.room ? multi.startReview : [],
      startWithout: app.mode === 'multi' && multi.room && multi.startWithout ? { playerIds: multi.startWithout.ids, message: multi.startWithout.message } : null,
      parties: game ? visibleParties(game.parties, scope(), game.player).map(p => ({ ...p, shipments: [...p.shipments], orders: [...p.orders],
        inTransit: p.shipments.map((quantity, i) => ({ quantity, arrivesWeek: game.week + i, leadTimeWeeks: i + 1 })) })) : [],
      lastWeek: game ? visibleHistory(game, scope(), game.player).at(-1) ?? null : null,
      debrief: game && over(game) && scope() === 'network' ? debrief(game) : null,
      error: app.error || (app.mode === 'multi' ? multi.error : ''),
      status: app.mode === 'multi' ? multi.status : 'Single player',
      leadTimes: { orders: 1, shipments: 2, production: scope() === 'network' || allowed.includes('Manufacturer') ? 2 : null }
    };
  };
  const waitUntil = async (predicate: () => boolean, timeoutMs: number, failOnError = true) => {
    const deadline = Date.now() + timeoutMs;
    while (!predicate()) {
      if (failOnError && app.multi.error) throw new Error(app.multi.error);
      if (Date.now() >= deadline) throw new Error('Timed out waiting for the supply chain. Inspect game state before retrying.');
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  };
  return {
    version: 1,
    state,
    async command(input: AgentCommand): Promise<unknown> {
      try {
        if (input.type === 'single' || input.type === 'create' || input.type === 'join') {
          if (app.mode || app.game || app.multi.room) throw new Error('This page already has a session. Create a separate session or leave first.');
          if (input.type !== 'join' && !(input.type === 'create' && input.kind === 'groups') && (!input.role || !ROLES.includes(input.role))) throw new Error('Choose a valid role.');
          if (input.visibility !== undefined && !VISIBILITY_LEVELS.includes(input.visibility)) throw new Error('Choose a valid information visibility level.');
          if (input.type === 'single') {
            const d = input.demand;
            if (d !== undefined && d !== 'standard' && !(DEMAND_METHODS.some(m => m.value === d?.method) && Number.isInteger(d.seed) && d.seed >= 0 && d.seed <= 4294967295)) throw new Error('Demand must be "standard" or a method (sma, wma or cyclic) with a seed from 0 to 4294967295.');
            app.visibility = input.visibility ?? 'network';
            app.mode = 'single'; app.selected = input.role!; app.start(d === undefined || d === 'standard' ? d : { method: d.method, seed: d.seed });
          } else {
            if (input.type === 'create' && (!input.name?.trim() || input.name.trim().length > 60)) throw new Error('Supply chain name must be 1–60 characters.');
            if (input.type === 'join' && !/^\d{6}$/.test(input.code ?? '')) throw new Error('Enter the six-digit game code.');
            app.mode = 'multi';
            const challenge = input.kind === 'classroom' ? { role: input.role!, seed: 42, method: 'sma' as const, ...input.challenge } : input.kind === 'groups' ? { seed: input.challenge?.seed ?? 42, method: input.challenge?.method ?? 'sma' } : input.challenge as ChallengeConfig | undefined;
            await app.multi.enter(input.type, input.name ?? '', input.code, input.visibility ?? 'network', { hostPlays: input.hostPlays, kind: input.kind, challenge });
            await waitUntil(() => !!app.multi.room, 15000);
            const nickname = input.nickname?.trim() || (input.role ?? app.multi.role ?? 'Player') + '-' + app.multi.id.slice(0, 6);
            app.multi.setNickname(nickname);
            await waitUntil(() => app.multi.nickname === nickname, 15000);
            if (!app.multi.isChallenge) { // Group players choose a role after joining a group.
              if (!input.role || !ROLES.includes(input.role)) throw new Error('Choose a valid role for Team Supply Chain.');
              if (app.multi.room!.members.some(m => m.role === input.role)) throw new Error('That role is already taken. Create another session with an available role.');
              app.multi.claim(input.role);
              await waitUntil(() => app.multi.role === input.role, 15000);
            }
            app.selected = app.multi.role;
          }
        } else if (input.type === 'start') {
          if (app.mode !== 'multi' || !app.multi.isHost) throw new Error('Only the multiplayer host can start the game.');
          if (app.multi.room?.started) throw new Error('This game has already started.');
          const without = input.withoutDisconnected ? app.multi.startWithout : null;
          if (input.withoutDisconnected && !without) throw new Error(`Starting without disconnected players is not possible now; inspect startWithout in state (${app.multi.lobbySummary}).`);
          if (!without && !app.multi.ready) throw new Error(`Every joined player must select a role and connect before starting (${app.multi.lobbySummary}).`);
          app.multi.start(without?.ids);
          await waitUntil(() => !!app.multi.game || !!app.multi.isObserver && !!app.multi.room?.started, 15000);
        } else if (input.type === 'role') {
          const room = app.multi.room, owner = app.multi.chain?.members.find(m => m.role === input.role); // Within this player's group in a Classroom Group Challenge.
          if (app.mode !== 'multi' || !room || room.started || app.multi.isClassroom || app.multi.isGroups && app.multi.isHost) throw new Error('Roles can change only in a team lobby, or within your group in a Classroom Group Challenge, before the game starts.');
          if (app.multi.isGroups && !app.multi.group) throw new Error('Join a group before choosing a role. Inspect groups in state.');
          if (!input.role || !ROLES.includes(input.role)) throw new Error('Choose a valid role.');
          if (owner && owner.id !== app.multi.id) throw new Error(`${input.role} is taken by ${owner.nickname || 'another player'}.`);
          app.multi.claim(input.role);
          await waitUntil(() => app.multi.role === input.role, 15000);
          app.selected = app.multi.role;
        } else if (input.type === 'createGroup' || input.type === 'joinGroup') {
          const room = app.multi.room;
          if (app.mode !== 'multi' || !room || room.started || !app.multi.isGroups || app.multi.isHost) throw new Error('Only players can create or join groups, in a Classroom Group Challenge lobby before it starts.');
          if (input.type === 'createGroup') {
            const name = input.groupName?.trim() ?? '';
            if (!name || name.length > 24) throw new Error('Group name must be 1–24 characters.');
            if (app.multi.groups.some(g => g.name.toLowerCase() === name.toLowerCase())) throw new Error(`A group named ${name} exists. Join it with beer_game_join_group, or choose another name.`);
            app.multi.createGroup(name);
            await waitUntil(() => app.multi.group?.name.toLowerCase() === name.toLowerCase(), 15000);
          } else {
            const group = app.multi.groups.find(g => g.id === input.group || g.name.toLowerCase() === input.group?.trim().toLowerCase());
            if (!group) throw new Error('Unknown group. Inspect groups in state.');
            if (group.id !== app.multi.group?.id) {
              if (room.members.filter(m => m.group === group.id).length >= 4) throw new Error(`${group.name} is full (4 of 4 players). Join another group or create one.`);
              app.multi.joinGroup(group.id);
              await waitUntil(() => app.multi.group?.id === group.id, 15000);
            }
            if (input.role && app.multi.role !== input.role) {
              if (!ROLES.includes(input.role)) throw new Error('Choose a valid role.');
              const owner = app.multi.chain?.members.find(m => m.role === input.role);
              if (owner) throw new Error(`Joined ${group.name}, but ${input.role} is taken by ${owner.nickname || 'another player'}. Choose another role with beer_game_change_role.`);
              app.multi.claim(input.role);
              await waitUntil(() => app.multi.role === input.role, 15000);
            }
          }
          app.selected = app.multi.role;
        } else if (input.type === 'remove') {
          if (app.mode !== 'multi' || !app.multi.isHost || app.multi.room?.started) throw new Error('Only the host can remove players, and only before the game starts.');
          const member = app.multi.awayMembers.find(m => m.id === input.playerId);
          if (!member) throw new Error('Only a disconnected lobby member can be removed. Inspect room.members[].canRemove in state.');
          app.multi.remove(member.id);
          await waitUntil(() => !app.multi.room?.members.some(m => m.id === member.id), 15000);
        } else if (input.type === 'order') {
          const game = app.mode === 'multi' ? app.multi.game : app.game;
          if (!game || game.complete) throw new Error('There is no active game.');
          if (over(game)) throw new Error('The host finished the classroom, so this run has ended.');
          if (!Number.isInteger(input.week) || input.week !== game.week) throw new Error(`Stale order: inspect state and submit for week ${game.week}.`);
          if (!Number.isInteger(input.amount) || input.amount! < 0 || input.amount! > 100) throw new Error('Order must be a whole number from 0 to 100.');
          if (app.mode === 'multi') {
            if (app.multi.replaced) throw new Error(app.multi.absences.find(a => a.role === app.multi.role)!.message);
            if (!connectedForPlay()) throw new Error('Waiting for the connected player roster.');
            const status = app.multi.orderStatus;
            if (status?.canRetry) { app.multi.resend(); return state(); } // Re-sends the unconfirmed order unchanged; the host records one per week.
            if (app.multi.submitted) throw new Error(`You already submitted an order this week.${status ? ' ' + status.message : ''}`);
            app.multi.submit(input.amount!);
            if (app.multi.error) throw new Error(app.multi.error);
          } else game.advance(input.amount!);
          app.order = input.amount!;
        } else if (input.type === 'wait') {
          const timeout = input.timeoutMs ?? 10000;
          if (!Number.isInteger(timeout) || timeout < 0 || timeout > 30000) throw new Error('timeoutMs must be 0–30000.');
          const deadline = Date.now() + timeout;
          while (Date.now() < deadline) {
            const current = state();
            if (current.error || current.complete || current.phase === 'complete' || input.afterWeek !== undefined && current.week !== null && current.week > input.afterWeek || input.afterWeek === undefined && (current.phase === 'playing' || current.phase === 'observing' || current.canStart)) break;
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        } else if (input.type === 'history' || input.type === 'export') {
          const game = app.mode === 'multi' ? app.multi.game : app.game;
          if (!game) throw new Error('There is no game yet.');
          return input.type === 'history' ? { visibility: level(), revealed: revealed(), history: visibleHistory(game, scope(), game.player) } : { filename: resultsFilename(game.player, app.mode === 'multi' ? app.multi.room : app.demand && !game.complete ? 'single-player' : app.demand), mimeType: 'text/csv', csv: visibleCsv(game, scope(), game.player) };
        } else if (input.type === 'decide') {
          // The host of a Classroom Group Challenge names the group (id or name); players decide only for their own.
          const group = app.multi.groups.find(g => g.id === input.group || g.name.toLowerCase() === input.group?.trim().toLowerCase());
          if (input.group && !group) throw new Error('Unknown group. Inspect absentPlayers[].group in state.');
          const open = app.mode === 'multi' ? app.multi.absences.filter(a => a.role === input.role && (!group || a.group === group.id)) : [];
          if (typeof input.systemPlays !== 'boolean') throw new Error('Set systemPlays to true (the system plays the role) or false (keep waiting).');
          if (open.length > 1) throw new Error('Several groups wait on that role. Name the group with group (absentPlayers[].group).');
          const absence = open[0];
          if (!absence?.canDecide || !input.systemPlays && absence.state !== 'left') throw new Error('There is no open decision for that role. Inspect absentPlayers in state.');
          app.multi.decide(absence.role, input.systemPlays, absence.group);
          await waitUntil(() => { const chain = app.multi.room && chainView(app.multi.room, absence.group); return !!(input.systemPlays ? chain?.automated : chain?.waiting)?.[absence.role]; }, 15000);
        } else if (input.type === 'finish') {
          if (app.mode !== 'multi' || !app.multi.isHost || !app.multi.isChallenge || !app.multi.room?.started) throw new Error('Only the host of a started classroom can finish it.');
          if (app.multi.revealed) throw new Error('The classroom has already finished.');
          app.multi.finishClassroom();
        } else if (input.type === 'leave') app.reset();
        else if (input.type !== 'state') throw new Error('Unknown game command.');
        return state();
      } finally { refresh(); }
    }
  };
}
