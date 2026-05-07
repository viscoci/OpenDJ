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
  template: ` <div class="qr" [style.--qr-size.px]="size" [innerHTML]="svg()"></div> `,
  styles: [
    `
      :host {
        display: inline-block;
      }
      .qr {
        /* border-box so the container's outer dimensions equal --qr-size.
           Without this the container is size + padding wide and visually
           overflows whatever flex/grid slot it sits in. */
        box-sizing: border-box;
        width: var(--qr-size);
        height: var(--qr-size);
        background: #fff;
        padding: 8px;
        border-radius: 8px;
        display: grid;
        place-items: center;
      }
      /* SVG comes from [innerHTML] — Angular's emulated encapsulation
         doesn't tag it with the scoped attribute selector, so a normal
         descendant rule wouldn't match. ::ng-deep punches through. */
      :host ::ng-deep .qr svg {
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
