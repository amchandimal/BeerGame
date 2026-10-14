import { BeerGame, ROLES, Role } from './game';
import type { ScoreRow } from './challenge';
import type { InformationVisibility } from './visibility';
import type { Room } from './multiplayer';

// Saved games in this browser: up to MAX_SAVES multiplayer saves, one key per room and member, plus one unfinished single-player game.
export const MAX_SAVES = 5;
const PREFIX = 'beer-game.multiplayer.v2.';
const OLD_KEY = 'beer-game.multiplayer.v1'; // The earlier single slot, moved to its own key on first read.
export const SINGLE_KEY = 'beer-game.single.v1';
const TAB_KEY = 'beer-game.tab'; // sessionStorage: this tab's single-player game, restored after a refresh of the same tab.
// groupPending: a Classroom Group Challenge host's orders for each group's current week (challengeGames then holds the group chains).
export interface SavedSession { version: 1; token: string; id: string; room: Room; savedAt: number; game: BeerGame | null; pending: Partial<Record<Role, number>>; challengeGames: [string, BeerGame][]; leaderboard: ScoreRow[]; challengeStarted: number; groupPending?: [string, Partial<Record<Role, number>>][]; }
export interface SingleSave { version: 1; visibility: InformationVisibility; game: BeerGame; savedAt: number; }

export const saveKey = (saved: { room: { code: string }; id: string }) => `${PREFIX}${saved.room.code}.${saved.id}`;
// A storage event from another tab that changes Your games: a multiplayer save added or removed, or the single-player save changed.
export const changesSaves = (e: { key: string | null; oldValue: string | null; newValue: string | null }) => e.key === null || e.key === SINGLE_KEY || e.key.startsWith(PREFIX) && (e.oldValue === null || e.newValue === null);
const valid = (saved: any): saved is SavedSession => saved?.version === 1 && typeof saved.token === 'string' && typeof saved.id === 'string' && /^\d{6}$/.test(saved.room?.code) && Number.isFinite(saved.savedAt);
const saveKeys = (storage: Storage) => Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => !!key?.startsWith(PREFIX));

export function restoreGame(data: BeerGame | null): BeerGame | null {
  if (!data) return null;
  if (!ROLES.includes(data.player) || !Number.isInteger(data.week) || data.week < 1 || data.week > 25 || data.history?.length !== data.week - 1 || data.parties?.length !== 4) throw new Error('Saved game data is invalid.');
  const game = new BeerGame(data.player, data.scenario, data.customer);
  game.week = data.week; game.history = data.history; game.parties = data.parties;
  return game;
}

// Every multiplayer save in this browser, most recently saved first. Invalid entries are removed.
export function readSaves(storage: Storage = globalThis.localStorage): SavedSession[] {
  try {
    const old = storage.getItem(OLD_KEY);
    if (old !== null) {
      const saved = (() => { try { return JSON.parse(old); } catch { return null; } })();
      if (valid(saved) && storage.getItem(saveKey(saved)) === null) storage.setItem(saveKey(saved), old);
      storage.removeItem(OLD_KEY);
    }
    const saves: SavedSession[] = [];
    for (const key of saveKeys(storage)) {
      const saved = (() => { try { return JSON.parse(storage.getItem(key)!); } catch { return null; } })();
      if (valid(saved) && saveKey(saved) === key) saves.push(saved); else storage.removeItem(key);
    }
    return saves.sort((a, b) => b.savedAt - a.savedAt);
  } catch { return []; } // Storage may be unavailable.
}
// Writes a save under its own key. A new save beyond MAX_SAVES replaces the least recently saved, sparing saves open in another tab (`open`) while others remain. Throws when storage refuses it.
export function writeSave(saved: SavedSession, storage: Storage = globalThis.localStorage, open: (key: string) => boolean = () => false) {
  const key = saveKey(saved), keys = saveKeys(storage);
  if (!keys.includes(key) && keys.length >= MAX_SAVES) {
    const old = readSaves(storage).sort((a, b) => Number(open(saveKey(a))) - Number(open(saveKey(b))) || a.savedAt - b.savedAt);
    for (const s of old.slice(0, old.length - MAX_SAVES + 1)) storage.removeItem(saveKey(s));
  }
  storage.setItem(key, JSON.stringify(saved));
}
export function removeSave(saved: SavedSession, storage: Storage = globalThis.localStorage) { try { storage.removeItem(saveKey(saved)); } catch {} }

export function readSingle(storage: Storage = globalThis.localStorage): SingleSave | null {
  try {
    const saved = JSON.parse(storage.getItem(SINGLE_KEY) ?? 'null');
    if (!saved) return null;
    const game = restoreGame(saved.game);
    if (saved.version === 1 && game && !game.complete && ['network', 'dyadic', 'none'].includes(saved.visibility)) return { ...saved, game };
  } catch { /* Invalid data is removed below. */ }
  try { storage.removeItem(SINGLE_KEY); } catch {}
  return null;
}
// Saves an unfinished single-player game (a finished one is removed). Returns false when storage refuses it.
export function writeSingle(game: BeerGame | null, visibility: InformationVisibility, storage: Storage = globalThis.localStorage, tab: Storage | null = sessionStorageOrNull()) {
  try {
    if (game && !game.complete) { storage.setItem(SINGLE_KEY, JSON.stringify({ version: 1, visibility, game, savedAt: Date.now() } satisfies SingleSave)); tab?.setItem(TAB_KEY, 'single'); }
    else { storage.removeItem(SINGLE_KEY); tab?.removeItem(TAB_KEY); }
    return true;
  } catch { return false; }
}
// A refresh of the tab that was playing restores its single-player game at once; other tabs list it under Your games.
export function tabHadSingle(tab: Storage | null = sessionStorageOrNull()) { try { return tab?.getItem(TAB_KEY) === 'single'; } catch { return false; } }
function sessionStorageOrNull() { try { return sessionStorage; } catch { return null; } }

// Which saved games are open in other tabs of this browser. Each tab announces the saves it has open (heartbeat every 5 seconds),
// answers a new tab's hello, and withdraws its list when the page is hidden for good; entries of a tab that stops answering expire.
export class TabPresence {
  private readonly id = Math.random().toString(36).slice(2);
  private readonly channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('beer-game.tabs') : null;
  private others = new Map<string, { keys: string[]; at: number }>();
  private mine: string[] = [];
  // open: the save keys this tab has open now; onChange: another tab's list changed.
  constructor(private open: () => string[], private onChange: () => void) {
    if (!this.channel) return;
    this.channel.onmessage = ({ data }) => {
      if (data?.type === 'hello') { this.mine = this.open(); if (this.mine.length) this.post(); }
      else if (data?.type === 'open' && typeof data.tab === 'string' && Array.isArray(data.keys)) {
        if (data.keys.length) this.others.set(data.tab, { keys: data.keys, at: Date.now() }); else this.others.delete(data.tab);
        this.onChange();
      }
    };
    this.channel.postMessage({ type: 'hello' });
    addEventListener('pagehide', () => this.channel!.postMessage({ type: 'open', tab: this.id, keys: [] }));
    addEventListener('pageshow', event => { if (event.persisted) { this.post(); this.channel!.postMessage({ type: 'hello' }); } });
    setInterval(() => {
      const had = this.mine.length;
      this.mine = this.open();
      if (this.mine.length || had) this.post();
      const stale = [...this.others].filter(([, o]) => Date.now() - o.at > 15000);
      for (const [tab] of stale) this.others.delete(tab);
      if (stale.length) this.onChange();
    }, 5000);
  }
  openElsewhere(key: string) { return [...this.others.values()].some(o => o.keys.includes(key)); }
  // Announces this tab's open saves when they change.
  update() { const keys = this.open(); if (keys.join() !== this.mine.join()) { this.mine = keys; this.post(); } }
  private post() { this.channel?.postMessage({ type: 'open', tab: this.id, keys: this.mine }); }
}
