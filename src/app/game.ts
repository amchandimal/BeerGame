export const ROLES = ['Retailer', 'Wholesaler', 'Distributor', 'Manufacturer'] as const;
export type Role = typeof ROLES[number];
export const WEEKS = 24;
export interface Party {
  role: Role; inventory: number; backlog: number; incoming: number; received: number;
  shipped: number; order: number; cost: number; shipments: number[]; orders: number[];
}
export interface RecordRow { week: number; demand: number; parties: Party[]; }
export class BeerGame {
  week = 1;
  history: RecordRow[] = [];
  parties: Party[] = ROLES.map(role => ({ role, inventory: 12, backlog: 0, incoming: 4,
    received: 0, shipped: 0, order: 4, cost: 0, shipments: [4, 4], orders: [4] }));
  // scenario: demand at the player's own role (Classroom Individual Challenge). customer: seeded customer demand for a whole chain (Classroom Group Challenge), passed upstream as usual.
  constructor(public player: Role, public scenario?: readonly number[], public customer?: readonly number[]) {}
  get complete() { return this.history.length === WEEKS; }
  get current() { return this.parties[ROLES.indexOf(this.player)]; }
  get currentDemand() { return this.scenario?.[this.week - 1] ?? (this.player === 'Retailer' ? this.demand() : this.current.orders[0]); }
  get weeklyCosts() { return { week: this.history.length, holding: this.history.length ? this.current.inventory * 0.5 : 0, backorder: this.history.length ? this.current.backlog : 0, holdingRate: 0.5, backorderRate: 1 }; }
  get demandLabel() { return this.player === 'Retailer' ? 'Customer demand' : `Placed order quantity from ${ROLES[ROLES.indexOf(this.player) - 1]}`; }
  get totalCost() { return this.parties.reduce((sum, p) => sum + p.cost, 0); }
  demand(week = this.week) { return this.scenario?.[week - 1] ?? this.customer?.[week - 1] ?? (week < 5 ? 4 : 8); }
  advance(playerOrder: number) {
    this.advanceWithOrders({ [this.player]: playerOrder });
  }
  advanceMultiplayer(orders: Partial<Record<Role, number>>, humanRoles: readonly Role[] = ROLES) {
    if (!humanRoles.length || !humanRoles.includes(this.player) || new Set(humanRoles).size !== humanRoles.length || humanRoles.some(role => !ROLES.includes(role))) throw new Error('Choose valid human-controlled roles.');
    if (humanRoles.some(role => !Object.hasOwn(orders, role))) throw new Error('All human players must submit an order.');
    if (Object.keys(orders).some(role => !humanRoles.includes(role as Role))) throw new Error('System-controlled roles cannot submit human orders.');
    this.advanceWithOrders(orders);
  }
  // A group's chain has no single player: the roles given order, the system plays the rest.
  advanceChain(orders: Partial<Record<Role, number>>) {
    if (Object.keys(orders).some(role => !ROLES.includes(role as Role))) throw new Error('Choose valid human-controlled roles.');
    this.advanceWithOrders(orders);
  }
  private advanceWithOrders(orders: Partial<Record<Role, number>>) {
    if (this.complete) throw new Error('The simulation has finished.');
    if (Object.values(orders).some(order => !Number.isInteger(order) || order! < 0 || order! > 100)) throw new Error('Order must be a whole number from 0 to 100.');
    const demand = this.demand();
    // Fulfill demand with shipments arriving this week, including outstanding backlog.
    this.parties.forEach((p, i) => {
      p.received = p.shipments.shift()!;
      p.inventory += p.received;
      p.incoming = i === 0 ? demand : p.orders.shift()!;
      if (this.scenario && p.role === this.player) p.incoming = this.scenario[this.week - 1];
      const required = p.incoming + p.backlog;
      p.shipped = Math.min(p.inventory, required);
      p.inventory -= p.shipped;
      p.backlog = required - p.shipped;
    });
    // Target three weeks on hand plus two weeks in transit; steady demand stays balanced.
    this.parties.forEach(p => {
      const position = p.inventory + p.shipments.reduce((a, b) => a + b, 0) - p.backlog;
      p.order = orders[p.role] ?? Math.min(100, Math.max(0, Math.round(5 * p.incoming - position)));
    });
    this.parties.forEach((p, i) => {
      p.shipments.push(i === 3 ? p.order : this.parties[i + 1].shipped);
      if (i > 0) p.orders.push(this.parties[i - 1].order);
      p.cost += p.inventory * 0.5 + p.backlog;
    });
    this.history.push({ week: this.week, demand, parties: this.parties.map(p => ({ ...p, shipments: [...p.shipments], orders: [...p.orders] })) });
    this.week++;
  }
  csv() {
    return ['Week,Customer demand,Party,Order,Received,Shipped,Inventory,Backlog,Cumulative cost', ...this.history.flatMap(r => r.parties.map(p => [r.week, r.demand, p.role, p.order, p.received, p.shipped, p.inventory, p.backlog, p.cost].join(',')))].join('\n');
  }
}
