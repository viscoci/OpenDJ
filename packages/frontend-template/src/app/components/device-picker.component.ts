/**
 * Spotify Connect device picker — collapses to a button until expanded,
 * then shows the host's available devices with the active one highlighted.
 * The parent does the actual fetch + activate calls; this component only
 * renders + emits.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  EventEmitter,
  Input,
  Output,
  signal,
} from '@angular/core';
import type { PlaybackDeviceWire } from '@opendj/frontend';

@Component({
  selector: 'app-device-picker',
  standalone: true,
  imports: [CommonModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="picker">
      <button
        type="button"
        class="trigger"
        (click)="toggle()"
        [disabled]="busy"
        [attr.aria-expanded]="expanded()"
      >
        <span class="trigger-label">
          @if (activeDevice(); as active) {
            <span class="dot" aria-hidden="true">●</span>
            Playing on {{ active.name }}
          } @else {
            No active device
          }
        </span>
        <span class="caret" aria-hidden="true">{{ expanded() ? '▾' : '▸' }}</span>
      </button>
      @if (expanded()) {
        <div class="panel">
          @if (busy && devices.length === 0) {
            <p class="hint">Loading devices…</p>
          } @else if (devices.length === 0) {
            <p class="hint">
              No devices visible. Open Spotify on a phone, computer, or speaker, then click Refresh.
            </p>
          } @else {
            <ul>
              @for (d of devices; track d.id) {
                <li>
                  <button
                    type="button"
                    class="device"
                    [class.active]="d.isActive"
                    [disabled]="d.isRestricted || d.isActive || busy"
                    (click)="activate.emit(d.id)"
                  >
                    <span class="device-name">{{ d.name }}</span>
                    <span class="device-type">{{ typeLabel(d.type) }}</span>
                    @if (d.isActive) {
                      <span class="device-status">active</span>
                    } @else if (d.isRestricted) {
                      <span class="device-status muted">restricted</span>
                    }
                  </button>
                </li>
              }
            </ul>
          }
          <div class="footer">
            <button type="button" class="refresh" (click)="refresh.emit()" [disabled]="busy">
              Refresh
            </button>
          </div>
        </div>
      }
    </div>
  `,
  styles: [
    `
      :host {
        display: block;
      }
      .picker {
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 12px;
        overflow: hidden;
      }
      .trigger {
        width: 100%;
        background: transparent;
        border: 0;
        padding: 12px 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
        color: inherit;
        font: inherit;
        font-size: 13px;
        cursor: pointer;
      }
      .trigger:hover:not(:disabled) {
        background: rgba(168, 85, 247, 0.08);
      }
      .dot {
        color: #34d399;
        margin-right: 6px;
      }
      .caret {
        color: #a294c5;
      }
      .panel {
        border-top: 1px solid #2c2440;
        padding: 10px 12px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .hint {
        margin: 0;
        font-size: 12px;
        color: #a294c5;
      }
      ul {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 4px;
      }
      .device {
        width: 100%;
        background: #0c0a14;
        border: 1px solid #2c2440;
        border-radius: 8px;
        padding: 8px 12px;
        display: flex;
        gap: 10px;
        align-items: center;
        font: inherit;
        font-size: 13px;
        color: inherit;
        text-align: left;
        cursor: pointer;
      }
      .device:hover:not(:disabled) {
        border-color: #a855f7;
      }
      .device:disabled {
        cursor: not-allowed;
      }
      .device.active {
        border-color: #34d399;
      }
      .device-name {
        flex: 1;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .device-type {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        color: #a294c5;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .device-status {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 10px;
        color: #34d399;
        text-transform: uppercase;
        letter-spacing: 0.06em;
      }
      .device-status.muted {
        color: #fda4af;
      }
      .footer {
        display: flex;
        justify-content: flex-end;
      }
      .refresh {
        background: transparent;
        border: 1px solid #2c2440;
        color: #c8b8e9;
        padding: 4px 12px;
        border-radius: 999px;
        font: inherit;
        font-size: 11px;
        cursor: pointer;
      }
      .refresh:disabled {
        opacity: 0.5;
        cursor: not-allowed;
      }
    `,
  ],
})
export class DevicePickerComponent {
  @Input() devices: ReadonlyArray<PlaybackDeviceWire> = [];
  @Input() busy = false;

  @Output() readonly refresh = new EventEmitter<void>();
  @Output() readonly activate = new EventEmitter<string>();

  protected readonly expanded = signal(false);

  protected toggle(): void {
    this.expanded.update((v) => !v);
    if (this.expanded()) this.refresh.emit();
  }

  protected activeDevice(): PlaybackDeviceWire | null {
    return this.devices.find((d) => d.isActive) ?? null;
  }

  protected typeLabel(t: PlaybackDeviceWire['type']): string {
    switch (t) {
      case 'computer':
        return 'Computer';
      case 'phone':
        return 'Phone';
      case 'tablet':
        return 'Tablet';
      case 'speaker':
        return 'Speaker';
      case 'tv':
        return 'TV';
      case 'cast_audio':
      case 'cast_video':
        return 'Cast';
      case 'automobile':
        return 'Car';
      default:
        return 'Device';
    }
  }
}
