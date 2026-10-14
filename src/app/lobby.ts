import type { Member, Room } from './multiplayer';
import { DEMAND_METHODS } from './challenge';
import { ROLES } from './game';
import { VISIBILITY_OPTIONS } from './visibility';

// Player-facing lobby states. Ready means the member meets every start rule; `linked` says whether a member has an open channel to the creator.
export type LobbyStatus = 'Enter nickname' | 'Join a group' | 'Choose role' | 'Connecting' | 'Ready' | 'Disconnected — can resume';
const ACTIONS: [LobbyStatus, string][] = [['Enter nickname', 'enter a nickname'], ['Join a group', 'join a group'], ['Choose role', 'choose a role'], ['Connecting', 'connect'], ['Disconnected — can resume', 'reconnect']];

const hostOnly = (room: Room, member: Member) => room.hostPlays === false && member.id === room.host;
export const list = (names: string[]) => names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

export function lobbyStatus(room: Room, member: Member, linked: (id: string) => boolean): LobbyStatus {
  if (member.online === false) return 'Disconnected — can resume';
  if (!member.nickname) return 'Enter nickname';
  if (room.kind === 'groups' && !member.group && !hostOnly(room, member)) return 'Join a group';
  if (!member.role && !hostOnly(room, member)) return 'Choose role'; // A host-only classroom creator never picks a role.
  return linked(member.id) ? 'Ready' : 'Connecting';
}

// "2 of 3 players ready · waiting for Alex to choose a role": every current blocker at once. A host-only creator is not counted as a player.
export function lobbySummary(room: Room, self: string, linked: (id: string) => boolean) {
  const players = room.members.filter(m => !hostOnly(room, m));
  const ready = players.filter(m => lobbyStatus(room, m, linked) === 'Ready').length;
  const waiting = ACTIONS.flatMap(([status, action]) => {
    const members = room.members.filter(m => lobbyStatus(room, m, linked) === status);
    const unnamed = members.filter(m => !m.nickname && m.id !== self).length;
    const names = [...members.some(m => m.id === self) ? ['you'] : [], ...members.filter(m => m.nickname && m.id !== self).map(m => m.nickname), ...unnamed ? [`${unnamed} new player${unnamed === 1 ? '' : 's'}`] : []];
    return names.length ? [`${list(names)} to ${action}`] : [];
  });
  if (!players.length) waiting.push('a player to join');
  return `${ready} of ${players.length} player${players.length === 1 ? '' : 's'} ready${waiting.length ? ' · waiting for ' + waiting.join('; ') : ''}`;
}

// Six-digit join code from typed or pasted text: whitespace, dashes and dots are ignored, and an invitation link to this site gives its code. Keep in step with joinCode in server/index.mjs.
export function joinCode(input: string, host: string): string | null {
  const text = String(input ?? '').trim(), link = text.match(/^https?:\/\/([^/?#]+)\/multiplayer\/join\/(\d{6})\/?(?:[?#].*)?$/i);
  if (link) return link[1].toLowerCase() === host.toLowerCase() ? link[2] : null;
  const digits = text.replace(/[\s.·\-\u2010-\u2015]/g, '');
  return /^\d{6}$/.test(digits) ? digits : null;
}

export const methodLabel = (method: string) => DEMAND_METHODS.find(m => m.value === method)?.label ?? method;
const people = (members: Member[]) => { const unnamed = members.filter(m => !m.nickname).length; return list([...members.flatMap(m => m.nickname ? [m.nickname] : []), ...unnamed ? [`${unnamed} new player${unnamed === 1 ? '' : 's'}`] : []]); };

// What starting now sets up, shown beside Start and in MCP state: mode, visibility, human and system-played roles, groups, and the classroom scenario.
export function startReview(room: Room): { label: string; value: string }[] {
  const visibility = { label: 'Visibility', value: VISIBILITY_OPTIONS.find(o => o.value === room.visibility)?.label ?? room.visibility };
  if (room.kind === 'groups') {
    const c = room.challenge!, groups = room.groups ?? [], inGroup = (id: string) => room.members.filter(m => m.group === id);
    const filled = groups.filter(g => inGroup(g.id).length), empty = groups.filter(g => !inGroup(g.id).length), loose = room.members.filter(m => !m.group && !hostOnly(room, m));
    return [{ label: 'Mode', value: 'Classroom Group Challenge' }, visibility, { label: 'Demand', value: `${methodLabel(c.method)} · seed ${c.seed}` },
      { label: 'Groups', value: filled.map(g => `${g.name}: ${inGroup(g.id).map(m => `${m.nickname || 'New player'} (${m.role ?? 'choosing'})`).join(', ')}`).join('; ') || 'None yet' },
      ...loose.length ? [{ label: 'Not in a group', value: people(loose) }] : [], ...empty.length ? [{ label: 'Dropped at start', value: `${list(empty.map(g => g.name))} (empty)` }] : [],
      { label: 'System plays', value: 'Roles nobody chose in each group' }];
  }
  if (room.kind === 'classroom') {
    const c = room.challenge!, players = room.members.filter(m => !hostOnly(room, m));
    return [{ label: 'Mode', value: 'Classroom Individual Challenge' }, visibility, { label: 'Everyone plays', value: c.role! }, { label: 'Demand', value: `${methodLabel(c.method)} · seed ${c.seed}` },
      { label: 'Competitors', value: `${players.length ? people(players) : 'None yet'}${room.hostPlays === false ? ' (you host only)' : ''}` },
      { label: 'System plays', value: `${ROLES.filter(r => r !== c.role).join(', ')} in every run` }];
  }
  const choosing = room.members.filter(m => !m.role).length, claimed = room.members.flatMap(m => m.role ? [m.role] : []), unclaimed = ROLES.filter(r => !claimed.includes(r));
  return [{ label: 'Mode', value: 'Team Supply Chain' }, visibility,
    { label: 'Players', value: [...room.members.flatMap(m => m.role ? [`${m.nickname || 'New player'} (${m.role})`] : []), ...choosing ? [`${choosing} still choosing`] : []].join(', ') },
    { label: 'System plays', value: choosing ? 'Roles nobody has chosen at start' : unclaimed.join(', ') || 'None' }];
}

// Starting without disconnected lobby members: a Team seat with a nickname and role stays and the system plays it (in a group, only beside a member who stays); anyone else is removed. Keep in step with the server's started handler.
export const keepsSeat = (room: Room, member: Member, away: Member[]) => !!member.nickname && !!member.role && (room.kind === 'team' || room.kind === 'groups' && room.members.some(m => m.group === member.group && m.id !== room.host && !away.includes(m)));
export function startWithoutPrompt(room: Room, away: Member[]) {
  const names = people(away), seats = away.filter(m => keepsSeat(room, m, away)).length;
  const effect = seats ? ` ${seats === 1 ? 'Their role' : 'Their roles'} will be played by the system.` : room.kind !== 'team' ? ' They will not be in this classroom.' : '';
  return { label: `Start without ${names}`, message: `Start without ${names}?${effect}` };
}
