/**
 * /host/login — email+password login + register, plus OAuth provider links.
 *
 * `mode` toggles between login and register. Register includes an optional
 * displayName field (used as the personal-account slug hint). Both paths
 * share the same backend bootstrap → on success, the user lands at
 * `/host/dashboard` with a fully-claimed session cookie.
 */

import { CommonModule } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
  type WritableSignal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { ApiError } from '@opendj/frontend';
import { AuthService } from '../../services/auth.service.js';
import { OpenDjClientService } from '../../services/opendj-client.service.js';

type Mode = 'login' | 'register';

@Component({
  selector: 'app-host-login',
  standalone: true,
  imports: [CommonModule, FormsModule],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <section class="card">
        <h1 class="brand">OpenDJ</h1>
        <div class="tabs" role="tablist">
          <button
            type="button"
            role="tab"
            [class.active]="mode() === 'login'"
            (click)="setMode('login')"
          >
            Sign in
          </button>
          <button
            type="button"
            role="tab"
            [class.active]="mode() === 'register'"
            (click)="setMode('register')"
          >
            Create account
          </button>
        </div>

        <form (ngSubmit)="submit()" #f="ngForm">
          <label>
            <span>Email</span>
            <input
              type="email"
              name="email"
              [(ngModel)]="form.email"
              autocomplete="email"
              required
            />
          </label>
          <label>
            <span>Password</span>
            <input
              type="password"
              name="password"
              [(ngModel)]="form.password"
              autocomplete="current-password"
              required
              minlength="8"
            />
          </label>
          @if (mode() === 'register') {
            <label>
              <span>Display name (optional)</span>
              <input
                type="text"
                name="displayName"
                [(ngModel)]="form.displayName"
                autocomplete="name"
              />
            </label>
          }
          <button type="submit" [disabled]="busy()">
            {{ busy() ? 'Working…' : mode() === 'login' ? 'Sign in' : 'Create account' }}
          </button>
          @if (error()) {
            <p class="error">{{ error() }}</p>
          }
        </form>

        <div class="divider"><span>or continue with</span></div>
        <a class="oauth" [href]="googleStartUrl">Sign in with Google</a>
        <p class="oauth-note">
          Apple and Facebook are scaffolded but not enabled in OSS — see
          <code>backend/auth/loginProviders/apple.ts</code>.
        </p>
      </section>
    </main>
  `,
  styles: [
    `
      :host {
        display: block;
        background: #0c0a14;
        color: #f3eef9;
        min-height: 100dvh;
        font-family:
          'Inter',
          -apple-system,
          BlinkMacSystemFont,
          sans-serif;
      }
      main {
        display: flex;
        align-items: center;
        justify-content: center;
        min-height: 100dvh;
        padding: 16px;
      }
      .card {
        width: 100%;
        max-width: 420px;
        background: #1a1525;
        border: 1px solid #2c2440;
        border-radius: 14px;
        padding: 28px;
      }
      .brand {
        font-family: 'Syne', 'Inter', sans-serif;
        font-size: 28px;
        margin: 0 0 24px;
        background: linear-gradient(135deg, #a855f7 0%, #ec4899 100%);
        -webkit-background-clip: text;
        background-clip: text;
        color: transparent;
      }
      .tabs {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 4px;
        background: #0c0a14;
        padding: 4px;
        border-radius: 10px;
        margin-bottom: 20px;
      }
      .tabs button {
        background: transparent;
        border: 0;
        color: #a294c5;
        font: inherit;
        padding: 8px;
        border-radius: 8px;
        cursor: pointer;
      }
      .tabs button.active {
        background: #2c2440;
        color: #f3eef9;
      }
      form {
        display: grid;
        gap: 12px;
      }
      label {
        display: flex;
        flex-direction: column;
        gap: 4px;
        font-size: 13px;
        color: #c8b8e9;
      }
      input {
        padding: 10px 12px;
        border-radius: 10px;
        border: 1px solid #2c2440;
        background: #0c0a14;
        color: #f3eef9;
        font-family: inherit;
        font-size: 14px;
      }
      input:focus {
        outline: 2px solid #a855f7;
        outline-offset: 1px;
      }
      button[type='submit'] {
        margin-top: 4px;
        padding: 12px;
        border-radius: 10px;
        border: 0;
        background: linear-gradient(135deg, #a855f7, #ec4899);
        color: white;
        font-weight: 600;
        font-size: 15px;
        cursor: pointer;
      }
      button[disabled] {
        opacity: 0.5;
        cursor: not-allowed;
      }
      .error {
        margin: 4px 0 0;
        color: #fda4af;
        font-size: 13px;
      }
      .divider {
        margin: 24px 0 16px;
        text-align: center;
        position: relative;
        color: #6b5d8a;
        font-size: 12px;
      }
      .divider::before,
      .divider::after {
        content: '';
        position: absolute;
        top: 50%;
        width: 35%;
        height: 1px;
        background: #2c2440;
      }
      .divider::before {
        left: 0;
      }
      .divider::after {
        right: 0;
      }
      .oauth {
        display: block;
        text-align: center;
        padding: 12px;
        border-radius: 10px;
        border: 1px solid #2c2440;
        color: #f3eef9;
        text-decoration: none;
        font-weight: 500;
      }
      .oauth:hover {
        border-color: #a855f7;
      }
      .oauth-note {
        margin: 12px 0 0;
        font-size: 12px;
        color: #6b5d8a;
      }
      code {
        font-family: 'JetBrains Mono', ui-monospace, monospace;
        font-size: 11px;
        background: #0c0a14;
        padding: 1px 4px;
        border-radius: 3px;
      }
    `,
  ],
})
export class HostLoginPage {
  private readonly auth = inject(AuthService);
  private readonly client = inject(OpenDjClientService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly mode: WritableSignal<Mode> = signal('login');
  readonly busy = signal(false);
  readonly error = signal<string | null>(null);

  form = { email: '', password: '', displayName: '' };
  redirectTo = '/host/dashboard';

  readonly googleStartUrl = this.client.client.auth.oauthStartUrl('google');

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      const dest = q.get('redirectTo');
      if (dest && dest.startsWith('/')) this.redirectTo = dest;
    });
  }

  setMode(m: Mode): void {
    this.mode.set(m);
    this.error.set(null);
  }

  async submit(): Promise<void> {
    this.busy.set(true);
    this.error.set(null);
    try {
      if (this.mode() === 'login') {
        await this.auth.login(this.form.email.trim(), this.form.password);
      } else {
        await this.auth.register(
          this.form.email.trim(),
          this.form.password,
          this.form.displayName.trim() || undefined,
        );
      }
      await this.router.navigateByUrl(this.redirectTo);
    } catch (err) {
      if (err instanceof ApiError) {
        this.error.set(this.errorMessage(err.code));
      } else {
        this.error.set('Something went wrong. Please try again.');
      }
    } finally {
      this.busy.set(false);
    }
  }

  private errorMessage(code: string): string {
    switch (code) {
      case 'invalid_credentials':
        return 'Email or password is incorrect.';
      case 'email_taken':
        return 'An account with that email already exists. Try signing in instead.';
      case 'account_locked':
        return 'Too many failed attempts. Try again in 15 minutes.';
      default:
        return `Could not complete the request (${code}).`;
    }
  }
}
