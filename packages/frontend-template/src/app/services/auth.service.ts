/**
 * AuthService — host-side auth state.
 *
 * Owns:
 * - Reactive `me` signal that mirrors `/api/v1/auth/me`
 * - Convenience login/register/logout that refresh the signal
 * - `requireHost()` route guard helper
 *
 * Loaded eagerly on app boot via `bootstrap()` so route guards have a
 * resolved snapshot to consult synchronously.
 */

import { Injectable, computed, inject, signal, type Signal } from '@angular/core';
import { Router } from '@angular/router';
import { ApiError, type MeResponse } from '@opendj/frontend';
import { OpenDjClientService } from './opendj-client.service.js';

export type AuthState =
  | { kind: 'unknown' }
  | { kind: 'anonymous' }
  | { kind: 'authenticated'; me: MeResponse };

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly client = inject(OpenDjClientService);
  private readonly router = inject(Router);
  private readonly _state = signal<AuthState>({ kind: 'unknown' });

  readonly state: Signal<AuthState> = this._state.asReadonly();
  readonly isAuthenticated = computed(() => this._state().kind === 'authenticated');
  readonly currentUser = computed(() => {
    const s = this._state();
    return s.kind === 'authenticated' ? s.me : null;
  });

  /**
   * Resolve the session by hitting `/auth/me`. Called once on app boot and
   * after every login/register/logout. Idempotent.
   */
  async refresh(): Promise<AuthState> {
    try {
      const me = await this.client.client.auth.me();
      this._state.set({ kind: 'authenticated', me });
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        this._state.set({ kind: 'anonymous' });
      } else {
        throw err;
      }
    }
    return this._state();
  }

  async login(email: string, password: string): Promise<MeResponse> {
    await this.client.client.auth.login({ email, password });
    const state = await this.refresh();
    if (state.kind !== 'authenticated') {
      throw new Error('AuthService.login: refresh returned non-authenticated state.');
    }
    return state.me;
  }

  async register(email: string, password: string, displayName?: string): Promise<MeResponse> {
    await this.client.client.auth.register({
      email,
      password,
      ...(displayName !== undefined && { displayName }),
    });
    const state = await this.refresh();
    if (state.kind !== 'authenticated') {
      throw new Error('AuthService.register: refresh returned non-authenticated state.');
    }
    return state.me;
  }

  async logout(): Promise<void> {
    try {
      await this.client.client.auth.logout();
    } catch {
      // logout is best-effort — clear local state regardless
    }
    this._state.set({ kind: 'anonymous' });
    await this.router.navigate(['/host/login']);
  }
}
