import { Component, Input } from '@angular/core';
import type { MultiplayerSession } from './multiplayer';

// Lobby participants with their group (Classroom Group Challenge), role and readiness (lobbyStatus in lobby.ts). The host element is the list.
@Component({
  selector: 'ul[appLobbyRoster]', standalone: true,
  template: `@for (member of multi.room!.members; track member.id) { @let status = multi.memberStatus(member); <li><span><strong>{{member.nickname || 'New player'}}</strong>{{member.group ? ' · ' + groupName(member.group) : ''}}{{member.role ? ' · ' + member.role : multi.room!.hostPlays === false && member.id === multi.room!.host ? ' · Host only' : ''}} {{member.id === multi.id ? '· You' : ''}} {{member.id === multi.room!.host ? '· Host' : ''}}</span><b class="member-status" [class.waiting]="status !== 'Ready'">{{status}}</b></li>}`
})
export class LobbyRosterComponent {
  @Input({ required: true }) multi!: MultiplayerSession;
  groupName(id: string) { return this.multi.groups.find(g => g.id === id)?.name ?? ''; }
}
