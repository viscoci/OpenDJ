/**
 * Standalone QR-code renderer. Wraps the `qrcode` lib's SVG generator so the
 * code stays crisp at any size. Consumes `value` + `size` and emits an SVG
 * via `[innerHTML]` (sanitized).
 *
 * Used by the host session page for the "share with your guests" pill and
 * by the TV view's join card.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  Input,
  OnChanges,
  signal,
  type SimpleChanges,
  inject,
} from '@angular/core';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import QRCode from 'qrcode';

@Component({
  selector: 'app-qr-code',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="qr" [style.--qr-size.px]="size">
      <div class="qr-svg" [innerHTML]="svg()"></div>
    </div>
  `,
  styles: [
    `
      :host {
        display: inline-block;
      }
      .qr {
        width: var(--qr-size);
        height: var(--qr-size);
        background: #fff;
        padding: 8px;
        border-radius: 8px;
        display: grid;
        place-items: center;
      }
      .qr-svg {
        width: 100%;
        height: 100%;
      }
      .qr-svg :global(svg) {
        width: 100%;
        height: 100%;
        display: block;
      }
    `,
  ],
})
export class QrCodeComponent implements OnChanges {
  private readonly sanitizer = inject(DomSanitizer);

  @Input({ required: true }) value!: string;
  @Input() size = 192;

  protected readonly svg = signal<SafeHtml>('');

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['value'] || changes['size']) {
      this.render();
    }
  }

  private render(): void {
    if (!this.value) {
      this.svg.set('');
      return;
    }
    QRCode.toString(this.value, {
      type: 'svg',
      margin: 1,
      width: this.size,
      color: { dark: '#0a0a12', light: '#ffffff' },
    })
      .then((svgText) => this.svg.set(this.sanitizer.bypassSecurityTrustHtml(svgText)))
      .catch(() => this.svg.set(''));
  }
}
