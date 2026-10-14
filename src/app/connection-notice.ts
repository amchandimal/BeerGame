import { Component, Input } from '@angular/core';
import type { MultiplayerSession } from './multiplayer';

// A multiplayer error without a field of its own, with Reconnect after a signaling drop. Reconnect calls multi.resume() directly,
// never AppComponent.resumeGame(), which would confirm and end the live session first.
@Component({
  selector: 'app-connection-notice', standalone: true, host: { style: 'display: contents' },
  template: `@if (multi.error && !multi.errorField) {<p class="error" role="alert">{{multi.error}}</p>@if (multi.canReconnect) {<button class="primary reconnect" (click)="multi.resume()">Reconnect</button>}}`
})
export class ConnectionNoticeComponent {
  @Input({ required: true }) multi!: MultiplayerSession;
}
