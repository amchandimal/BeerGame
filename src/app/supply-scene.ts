import { Component, Input } from '@angular/core';
import { BeerGame, Role } from './game';
import type { Absence } from './multiplayer';
import { InformationVisibility, visibleRoles } from './visibility';

@Component({
  selector: 'app-supply-scene', standalone: true,
  templateUrl: './supply-scene.html', styleUrl: './supply-scene.css'
})
export class SupplySceneComponent {
  @Input({ required: true }) game!: BeerGame;
  @Input() humanRoles: readonly Role[] = [];
  @Input() absences: readonly Absence[] = [];
  @Input() revealed: readonly Role[] = []; // Stations hidden during play, shown after the game.
  @Input() visibility: InformationVisibility = 'network';
  canSee(role: Role) { return visibleRoles(this.visibility, this.game.player).includes(role); }
  @Input() absentAtStart: readonly Role[] = []; // Seats the host started without: offline, not left.
  marker(role: Role) {
    let left = this.absences.find(a => a.role === role && a.state === 'system')?.nickname;
    // Long nicknames are shortened so the label stays inside the station card at phone text sizes.
    if (left && left.length > 14) left = left.slice(0, 13) + '…';
    return role === this.game.player ? 'YOUR STATION' : this.revealed.includes(role) ? 'REVEALED AFTER THE GAME' : left ? `SYSTEM (${left.toUpperCase()} ${this.absentAtStart.includes(role) ? 'OFFLINE' : 'LEFT'})` : this.humanRoles.includes(role) ? 'TEAM PLAYER' : 'SYSTEM PLAYER';
  }
  open = true; // Narrow layouts can collapse the board; it stays rendered so each week's animation still plays once.
  @Input({ required: true }) set completedWeek(value: number) {
    this.activityWeek = value;
    this.paused = false;
    this.finished = false;
  }
  activityWeek = 0;
  paused = false;
  finished = false;
  get sceneKey() { return this.activityWeek; }
  get displayParties() { return [...this.game.parties].reverse(); }
  crates(stock: number) { return Array.from({ length: Math.min(12, stock) }, (_, i) => i); }
  rolesLabel(index: number) { return `${this.game.parties[index + 1].role} → ${this.game.parties[index].role}`; }
}
