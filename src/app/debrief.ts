import { BeerGame, Role, ROLES } from './game';
import type { DemandConfig } from './challenge';
import { methodLabel } from './lobby';

export interface RoleDebrief { role: Role; orderSwing: number | null; orderStdDev: number; peakBacklog: number; holdingCost: number; backlogCost: number; totalCost: number; }
export interface Debrief { weeks: number; demandStdDev: number; roles: RoleDebrief[]; team: { holdingCost: number; backlogCost: number; totalCost: number }; }

const stdDev = (values: number[]) => { const mean = values.reduce((a, b) => a + b, 0) / values.length; return Math.sqrt(values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length); };

// Post-game figures from the engine's history, shared by the UI and MCP. Holding plus backlog cost equals each party's cumulative cost; roles sum to the team total.
// Order swing is the standard deviation of a role's weekly orders divided by that of customer demand (null when demand never varied).
export function debrief(game: BeerGame): Debrief | null {
  if (!game.history.length) return null;
  const { holdingRate, backorderRate } = game.weeklyCosts, demandStdDev = stdDev(game.history.map(row => row.demand));
  const roles = ROLES.map((role, i) => {
    const rows = game.history.map(row => row.parties[i]), orderStdDev = stdDev(rows.map(p => p.order));
    return { role, orderSwing: demandStdDev ? orderStdDev / demandStdDev : null, orderStdDev, peakBacklog: Math.max(...rows.map(p => p.backlog)),
      holdingCost: rows.reduce((sum, p) => sum + p.inventory * holdingRate, 0), backlogCost: rows.reduce((sum, p) => sum + p.backlog * backorderRate, 0), totalCost: game.parties[i].cost };
  });
  const sum = (key: 'holdingCost' | 'backlogCost') => roles.reduce((total, r) => total + r[key], 0);
  return { weeks: game.history.length, demandStdDev, roles, team: { holdingCost: sum('holdingCost'), backlogCost: sum('backlogCost'), totalCost: game.totalCost } };
}

// A Single Player game's demand, shown once it is over: "Weighted moving average · seed 123456789", or the classic demand (null).
export const scenarioLabel = (demand: DemandConfig | null) => demand ? `${methodLabel(demand.method)} · seed ${demand.seed}` : 'Classic 4 → 8';

// Download name: room (or the Single Player scenario, "single-player" while it is hidden, "standard" for the classic demand), role and local date,
// for example beer-game-sydney-class-482913-retailer-2026-10-11.csv or beer-game-wma-seed-123456789-retailer-2026-10-11.csv.
export function resultsFilename(role: Role, from: { name: string; code: string } | DemandConfig | 'single-player' | null, date = new Date()) {
  const where = !from ? 'standard' : from === 'single-player' ? from : 'code' in from ? [from.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, ''), from.code].filter(Boolean).join('-') : `${from.method}-seed-${from.seed}`;
  const day = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(n => String(n).padStart(2, '0')).join('-');
  return `beer-game-${where}-${role.toLowerCase()}-${day}.csv`;
}
