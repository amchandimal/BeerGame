import { ChangeDetectorRef, Component, Input, OnChanges, OnDestroy, inject } from '@angular/core';
import { toDataURL } from 'qrcode';

// Join code, QR image, link and the share or copy actions for a room. If the QR code cannot be drawn, the link and code stay.
@Component({
  selector: 'app-invitation', standalone: true, host: { style: 'display: contents' },
  template: `<span>Join code</span><strong class="room-code">{{code}}</strong><div class="invitation">@if (qrCode) {<img [src]="qrCode" width="220" height="220" alt="Scan to open this game’s join page">}<div><h2>Invite players</h2><p>{{qrFailed ? 'The QR code is unavailable. Share the link or the code.' : 'Scan with a phone camera to open the join page with the code filled in.'}}</p><a [href]="url">{{url}}</a><div class="invite-actions"><button class="quiet" (click)="share()">{{canShare ? 'Share invitation' : 'Copy invitation link'}}</button><button class="quiet" (click)="copy(code, 'Code copied ✓')">Copy code</button></div><span class="copy-status" role="status">{{copyStatus}}</span>@if (local) {<p class="hint">This localhost link works only on this computer. For phones, open the host page using a network-accessible address or your hosted site before sharing.</p>}</div></div>`
})
export class InvitationComponent implements OnChanges, OnDestroy {
  private cdr = inject(ChangeDetectorRef);
  @Input({ required: true }) code = '';
  @Input({ required: true }) name = '';
  readonly canShare = typeof navigator.share === 'function' && matchMedia('(pointer: coarse)').matches; // Phones with a share sheet.
  readonly local = ['localhost', '127.0.0.1'].includes(location.hostname);
  qrCode = '';
  qrFailed = false;
  copyStatus = '';
  private copyTimer?: ReturnType<typeof setTimeout>;
  get url() { return `${location.origin}/multiplayer/join/${this.code}`; }
  ngOnChanges() {
    const url = this.url;
    this.qrCode = ''; this.qrFailed = false; this.copyStatus = '';
    void toDataURL(url, { width: 220, margin: 4, errorCorrectionLevel: 'M' }).then(data => { if (this.url === url) { this.qrCode = data; this.cdr.markForCheck(); } })
      .catch(() => { if (this.url === url) { this.qrFailed = true; this.cdr.markForCheck(); } });
  }
  ngOnDestroy() { clearTimeout(this.copyTimer); }
  // On phones the share sheet sends the invitation; elsewhere, or when sharing fails, the link is copied.
  async share() {
    if (this.canShare) try { await navigator.share({ title: `Join ${this.name}`, text: `Join ${this.name} with code ${this.code}.`, url: this.url }); return; } catch (e) { if ((e as Error).name === 'AbortError') return; }
    await this.copy(this.url, 'Link copied ✓');
  }
  // Brief status beside the copy buttons; the link and code stay selectable if copying fails.
  async copy(text: string, done: string) {
    try { await navigator.clipboard.writeText(text); this.copyStatus = done; } catch { this.copyStatus = 'Copy is unavailable. Select the link or code to copy it.'; }
    clearTimeout(this.copyTimer); this.copyTimer = setTimeout(() => { this.copyStatus = ''; this.cdr.markForCheck(); }, 5000);
    this.cdr.markForCheck();
  }
}
