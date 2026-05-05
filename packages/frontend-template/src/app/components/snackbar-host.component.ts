/**
 * Renders the global snackbar stack from `SnackbarService`. Drop a single
 * `<app-snackbar-host />` somewhere in the root app so toasts appear over
 * the page content regardless of route or scroll position.
 *
 * Visual: bottom-right stack on desktop, bottom-centered on mobile. Each
 * toast is dismissible.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { SnackbarService } from '../services/snackbar.service.js';

@Component({
  selector: 'app-snackbar-host',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="stack" role="region" aria-live="polite" aria-label="Notifications">
      @for (m of snackbar.messages(); track m.id) {
        <div class="toast" [attr.data-kind]="m.kind">
          <span class="message">{{ m.message }}</span>
          <button
            type="button"
            class="dismiss"
            (click)="snackbar.dismiss(m.id)"
            aria-label="Dismiss"
          >
            ✕
          </button>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        position: fixed;
        right: 16px;
        bottom: 16px;
        left: auto;
        z-index: 9999;
        pointer-events: none;
      }
      @media (max-width: 600px) {
        :host {
          right: 16px;
          bottom: 16px;
          left: 16px;
        }
      }
      .stack {
        display: flex;
        flex-direction: column;
        gap: 8px;
        align-items: flex-end;
        max-width: 420px;
      }
      @media (max-width: 600px) {
        .stack {
          align-items: stretch;
          max-width: none;
        }
      }
      .toast {
        pointer-events: auto;
        background: #1a1525;
        border: 1px solid #2c2440;
        color: #f3eef9;
        padding: 12px 14px;
        border-radius: 12px;
        display: flex;
        align-items: center;
        gap: 12px;
        font-size: 13px;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.5);
        animation: slide-in 200ms ease-out;
      }
      .toast[data-kind='success'] {
        border-color: rgba(52, 211, 153, 0.4);
      }
      .toast[data-kind='warning'] {
        border-color: rgba(245, 158, 11, 0.5);
        color: #fcd34d;
      }
      .toast[data-kind='error'] {
        border-color: rgba(239, 68, 68, 0.5);
        color: #fda4af;
      }
      .message {
        flex: 1;
      }
      .dismiss {
        background: transparent;
        border: 0;
        color: inherit;
        opacity: 0.6;
        cursor: pointer;
        font: inherit;
        font-size: 12px;
        padding: 0 4px;
      }
      .dismiss:hover {
        opacity: 1;
      }
      @keyframes slide-in {
        from {
          transform: translateY(8px);
          opacity: 0;
        }
        to {
          transform: translateY(0);
          opacity: 1;
        }
      }
    `,
  ],
})
export class SnackbarHostComponent {
  protected readonly snackbar = inject(SnackbarService);
}
