import { BeerGame, Party, Role, ROLES } from './game';

export const VISIBILITY_LEVELS = ['network', 'dyadic', 'none'] as const;
export type InformationVisibility = typeof VISIBILITY_LEVELS[number];
export const VISIBILITY_OPTIONS: { value: InformationVisibility; label: string; description: string }[] = [
  { value: 'network', label: 'Network Wide', description: 'Stock levels, orders, lead times and costs across all four roles.' },
  { value: 'dyadic', label: 'Dyadic', description: 'Your role and the immediately connected supplier and customer roles.' },
  { value: 'none', label: 'None', description: 'Only your own role’s stock, orders, lead times and costs.' }
];
// Hidden information is revealed once the game is over; before that every output follows the chosen level.
export function dataScope(level: InformationVisibility, revealed: boolean): InformationVisibility { return revealed ? 'network' : level; }
export function visibleRoles(level: InformationVisibility, role: Role): Role[] {
  const index = ROLES.indexOf(role);
  if (index < 0) return [];
  return ROLES.filter((candidate, i) => level === 'network' || candidate === role || level === 'dyadic' && Math.abs(i - index) === 1);
}
export function visibleParties(parties: Party[], level: InformationVisibility, role: Role) {
  const allowed = visibleRoles(level, role);
  return parties.filter(p => allowed.includes(p.role));
}
export function visibleHistory(game: BeerGame, level: InformationVisibility, role: Role) {
  const showDemand = visibleRoles(level, role).includes('Retailer');
  return game.history.map(row => ({ week: row.week, demand: showDemand ? row.demand : null, parties: visibleParties(row.parties, level, role) }));
}
export function visiblePending(pending: Partial<Record<Role, number>>, level: InformationVisibility, role: Role): Partial<Record<Role, number>> {
  const allowed = visibleRoles(level, role);
  return Object.fromEntries(Object.entries(pending).filter(([key]) => allowed.includes(key as Role)));
}
export function visibleCsv(game: BeerGame, level: InformationVisibility, role: Role) {
  return ['Week,Customer demand,Party,Order,Received,Shipped,Inventory,Backlog,Cumulative cost', ...visibleHistory(game, level, role).flatMap(row => row.parties.map(p => [row.week, row.demand ?? '', p.role, p.order, p.received, p.shipped, p.inventory, p.backlog, p.cost].join(',')))].join('\n');
}
// Guest models retain fixed role positions for the existing UI; hidden values never arrive on the wire.
export function hiddenParty(role: Role): Party {
  return { role, inventory: 0, backlog: 0, incoming: 0, received: 0, shipped: 0, order: 0, cost: 0, shipments: [], orders: [] };
}
