import { Role, WEEKS } from './game';

export type DemandMethod = 'sma' | 'wma' | 'cyclic';
export interface ChallengeConfig { role: Role; seed: number; method: DemandMethod; }
// The seeded demand scenario alone: a Classroom Group Challenge has no shared role.
export type DemandConfig = Pick<ChallengeConfig, 'seed' | 'method'>;
export const DEMAND_METHODS = [
  { value: 'sma', label: 'Simple moving average', description: '3-week average with seeded demand variation.' },
  { value: 'wma', label: 'Weighted moving average', description: '3-week average weighted 1:2:3 toward recent demand, with seeded variation.' },
  { value: 'cyclic', label: 'Cyclic demand', description: 'An 8-week seasonal cycle with seeded variation.' }
] as const;

/** Reproducible teaching scenarios, not forecasts of real-world sales. */
export function demandScenario(config: DemandConfig): number[] {
  let state = config.seed >>> 0;
  const random = () => { state = (Math.imul(1664525, state) + 1013904223) >>> 0; return state / 4294967296; };
  const history = [4, 4, 4];
  const phase = random() * Math.PI * 2;
  return Array.from({ length: WEEKS }, (_, i) => {
    const last = history.slice(-3);
    const baseline = config.method === 'cyclic' ? 8 + 4 * Math.sin(2 * Math.PI * i / 8 + phase)
      : config.method === 'wma' ? (last[0] + 2 * last[1] + 3 * last[2]) / 6
      : (last[0] + last[1] + last[2]) / 3;
    const value = Math.max(1, Math.min(20, Math.round(baseline + (random() * 4 - 2))));
    history.push(value); return value;
  });
}

export interface ScoreRow {
  id: string; nickname: string; completedWeeks: number; cost: number | null;
  elapsedMs: number | null; finished: boolean; connected: boolean;
  incomplete?: boolean; // Stopped unfinished when the creator finished the classroom.
  members?: { nickname: string; role: Role }[]; // Classroom Group Challenge: a row is a group (id and nickname are its id and name), cost is its total chain cost.
}
export type ScoreStatus = 'playing' | 'disconnected' | 'finished' | 'incomplete';
export const scoreStatus = (row: ScoreRow): ScoreStatus => row.finished ? 'finished' : row.incomplete ? 'incomplete' : row.connected ? 'playing' : 'disconnected';
export function rankScores(rows: ScoreRow[]): ScoreRow[] {
  return [...rows].sort((a, b) => Number(b.finished) - Number(a.finished) ||
    (a.finished && b.finished ? a.cost! - b.cost! || a.elapsedMs! - b.elapsedMs! : b.completedWeeks - a.completedWeeks) || a.nickname.localeCompare(b.nickname));
}
