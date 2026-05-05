/**
 * Tiny global snackbar service. Any page or component can post a message
 * via `inject(SnackbarService).show({...})`; the host application root
 * renders an `<app-snackbar-host>` that subscribes to this service and
 * displays the toasts in a fixed-position stack.
 *
 * Kept dead-simple by design — no queue priorities, no positioning
 * variants, no slot-by-slot animations. The OSS demo doesn't need a full
 * notification framework; opendj.live can swap in something heavier.
 */

import { Injectable, signal, type WritableSignal } from '@angular/core';

export type SnackbarKind = 'info' | 'success' | 'warning' | 'error';

export interface SnackbarMessage {
  id: number;
  message: string;
  kind: SnackbarKind;
  /** Auto-dismiss after this many ms. Default 4000. Pass 0 to disable. */
  durationMs: number;
}

@Injectable({ providedIn: 'root' })
export class SnackbarService {
  private nextId = 1;
  readonly messages: WritableSignal<ReadonlyArray<SnackbarMessage>> = signal([]);

  show(input: { message: string; kind?: SnackbarKind; durationMs?: number }): number {
    const id = this.nextId++;
    const msg: SnackbarMessage = {
      id,
      message: input.message,
      kind: input.kind ?? 'info',
      durationMs: input.durationMs ?? 4000,
    };
    this.messages.update((list) => [...list, msg]);
    if (msg.durationMs > 0) {
      setTimeout(() => this.dismiss(id), msg.durationMs);
    }
    return id;
  }

  /** Convenience helpers — short-circuit the kind. */
  info(message: string, durationMs?: number): number {
    return this.show(
      durationMs !== undefined ? { message, kind: 'info', durationMs } : { message, kind: 'info' },
    );
  }
  success(message: string, durationMs?: number): number {
    return this.show(
      durationMs !== undefined
        ? { message, kind: 'success', durationMs }
        : { message, kind: 'success' },
    );
  }
  warning(message: string, durationMs?: number): number {
    return this.show(
      durationMs !== undefined
        ? { message, kind: 'warning', durationMs }
        : { message, kind: 'warning' },
    );
  }
  error(message: string, durationMs?: number): number {
    return this.show(
      durationMs !== undefined
        ? { message, kind: 'error', durationMs }
        : { message, kind: 'error' },
    );
  }

  dismiss(id: number): void {
    this.messages.update((list) => list.filter((m) => m.id !== id));
  }
}
