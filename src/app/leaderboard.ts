import { Component, EventEmitter, Input, Output } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ScoreRow, ScoreStatus, scoreStatus } from './challenge';
import { WEEKS } from './game';
import type { MultiplayerSession } from './multiplayer';

// Classroom leaderboard body, shared by the observer and player views: counts by status, find and filter from 10 rows (groups: 10 players), the table and,
// on phones, cards. Ranks stay those of the whole class. Rows hold nothing focusable, so reordering never moves focus. In a Classroom Group Challenge a row is a group with its members.
// The find and filter values belong to the page (two-way bound), so they survive switching views.
@Component({
  selector: 'app-leaderboard', standalone: true, imports: [CurrencyPipe, FormsModule], host: { style: 'display: contents' },
  template: `@let counts = multi.classroomCounts; @let groups = multi.isGroups;<ul class="class-counts" [attr.aria-label]="groups ? 'Groups by status' : 'Players by status'"><li>Playing {{counts.playing}}</li><li>Disconnected {{counts.disconnected}}</li><li>Finished {{counts.finished}}</li><li>Incomplete {{counts.incomplete}}</li>@if (multi.isHost) {<li class="host-link" [class.lost]="!multi.online">Your connection: {{multi.online ? 'online' : 'lost'}}</li>}</ul><p class="rank-note">{{groups ? 'Unfinished groups are ordered by progress; finished groups are ranked by total chain cost, then time.' : 'Unfinished players are ordered by progress; finished players are ranked by cost, then time.'}}</p>
    @if (manyPlayers) {<div class="leader-filters"><label for="find-player">{{groups ? 'Find a group or player' : 'Find a player'}}</label><input id="find-player" type="search" autocomplete="off" [ngModel]="search" (ngModelChange)="searchChange.emit($event)"><label for="status-filter">Status</label><select id="status-filter" [ngModel]="status" (ngModelChange)="statusChange.emit($event)"><option value="">All</option>@for (f of statusFilters; track f[0]) {<option [value]="f[0]">{{f[1]}}</option>}</select><p class="filter-count" role="status">{{rows.length === multi.leaderboard.length ? '' : 'Showing ' + rows.length + ' of ' + multi.leaderboard.length + (groups ? ' groups.' : ' players.')}}</p></div>}
    <div class="table-wrap"><table><thead><tr><th>Rank</th><th>{{groups ? 'Group' : 'Player'}}</th>@if (groups) {<th>Members</th>}<th>Progress</th><th>Cost</th><th>Time</th></tr></thead><tbody>@for (r of rows; track r.row.id) {<tr [class.you]="r.row.id === multi.scoreId"><td>{{r.rank ?? '—'}}</td><td>{{r.row.nickname}}{{you(r.row)}}</td>@if (groups) {<td>{{members(r.row)}}</td>}<td>{{progress(r.row)}}</td><td>{{r.row.cost === null ? '—' : (r.row.cost | currency)}}</td><td>{{duration(r.row.elapsedMs)}}</td></tr>}</tbody></table></div>
    <ul class="result-cards">@for (r of rows; track r.row.id) {<li [class.you]="r.row.id === multi.scoreId"><strong>{{r.rank ? r.rank + '. ' : ''}}{{r.row.nickname}}{{you(r.row)}}</strong><span>{{progress(r.row)}}</span>@if (groups) {<small>{{members(r.row)}}</small>}<small>Cost {{r.row.cost === null ? '—' : (r.row.cost | currency)}}{{r.row.elapsedMs === null ? '' : ' · Time ' + duration(r.row.elapsedMs)}}</small></li>}</ul>@if (!rows.length) {<p class="empty">No {{groups ? 'groups' : 'players'}} match.</p>}`
})
export class LeaderboardComponent {
  @Input({ required: true }) multi!: MultiplayerSession;
  @Input() search = '';
  @Output() searchChange = new EventEmitter<string>();
  @Input() status: ScoreStatus | '' = '';
  @Output() statusChange = new EventEmitter<ScoreStatus | ''>();
  readonly statusFilters: [ScoreStatus, string][] = [['playing', 'Playing'], ['disconnected', 'Disconnected'], ['finished', 'Finished'], ['incomplete', 'Incomplete']];
  get manyPlayers() { return (this.multi.isGroups ? this.multi.leaderboard.reduce((n, row) => n + (row.members?.length ?? 0), 0) : this.multi.leaderboard.length) >= 10; }
  get rows() {
    const query = this.manyPlayers ? this.search.trim().toLowerCase() : '', status = this.manyPlayers ? this.status : '';
    return this.multi.leaderboard.map((row, i) => ({ row, rank: row.finished ? i + 1 : null, status: scoreStatus(row) }))
      .filter(r => (!query || [r.row.nickname, ...r.row.members?.map(m => m.nickname) ?? []].some(name => name.toLowerCase().includes(query))) && (!status || r.status === status));
  }
  you(row: ScoreRow) { return row.id !== this.multi.scoreId ? '' : this.multi.isGroups ? ' · Your group' : ' · You'; }
  members(row: ScoreRow) { return row.members?.map(m => `${m.nickname} (${m.role})`).join(', ') ?? ''; }
  progress(row: ScoreRow) { const weeks = `${row.completedWeeks} / ${WEEKS}`; return { finished: 'Finished', incomplete: `Incomplete · ${weeks}`, disconnected: `Disconnected · ${weeks}`, playing: weeks }[scoreStatus(row)]; }
  duration(ms: number | null) { if (ms === null) return '—'; const seconds = Math.floor(ms / 1000); return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0'); }
}
