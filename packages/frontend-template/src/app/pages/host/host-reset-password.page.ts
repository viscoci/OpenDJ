/**
 * /host/reset-password?token=… — complete a password reset.
 *
 * The token arrives via the emailed link built by the backend's
 * PasswordResetService. Submitting swaps the password and revokes every
 * existing session, so on success the user is sent to /host/login (with a
 * `passwordReset` navigation-state hint) to sign in fresh. A missing or
 * rejected token shows an error with a path back to requesting a new link.
 */

import { CommonModule } from '@angular/common';
import { ChangeDetectionStrategy, Component, DestroyRef, inject, signal } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router, RouterLink } from '@angular/router';
import { ApiError } from '@opendj/frontend';
import { OpenDjClientService } from '../../services/opendj-client.service.js';

@Component({
  selector: 'app-host-reset-password',
  standalone: true,
  imports: [CommonModule, FormsModule, RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <main>
      <section class="card">
        <h1 class="brand">OpenDJ</h1>
        <h2 class="subhead">Choose a new password</h2>

        @if (!token()) {
          <p class="error">
            This reset link is missing its token. Request a new link from the sign-in page.
          </p>
          <a class="link" routerLink="/host/login">Back to sign in</a>
        } @else {
          <form (ngSubmit)="submit()" #f="ngForm">
            <label>
              <span>New password</span>
              <input
                type="password"
                name="password"
                [(ngModel)]="form.password"
                autocomplete="new-password"
                required
                minlength="8"
              />
            </label>
            <label>
              <span>Confirm new password</span>
              <input
                type="password"
                name="confirm"
                [(ngModel)]="form.confirm"
                autocomplete="new-password"
                required
                minlength="8"
              />
            </label>
            <button type="submit" [disabled]="busy()">
              {{ busy() ? 'Working…' : 'Set new password' }}
            </button>
            @if (error()) {
              <p class="error">{{ error() }}</p>
            }
          </form>
          <a class="link" routerLink="/host/login">Back to sign in</a>
        }
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
      .subhead {
        font-size: 18px;
        margin: 0 0 20px;
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
      .link {
        display: inline-block;
        margin-top: 12px;
        color: #a855f7;
        font-size: 13px;
        text-decoration: none;
      }
      .link:hover {
        text-decoration: underline;
      }
    `,
  ],
})
export class HostResetPasswordPage {
  private readonly client = inject(OpenDjClientService);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly destroyRef = inject(DestroyRef);

  readonly busy = signal(false);
  readonly error = signal<string | null>(null);
  readonly token = signal<string | null>(null);

  form = { password: '', confirm: '' };

  constructor() {
    this.route.queryParamMap.pipe(takeUntilDestroyed(this.destroyRef)).subscribe((q) => {
      this.token.set(q.get('token'));
    });
  }

  async submit(): Promise<void> {
    const token = this.token();
    if (!token) return;
    if (this.form.password.length < 8) {
      this.error.set('Password must be 8–200 characters.');
      return;
    }
    if (this.form.password !== this.form.confirm) {
      this.error.set('Passwords do not match.');
      return;
    }
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.client.client.auth.resetPassword(token, this.form.password);
      await this.router.navigate(['/host/login'], { state: { passwordReset: true } });
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
      case 'invalid_or_expired_token':
        return 'This reset link is invalid or has expired. Request a new one from the sign-in page.';
      case 'invalid_password':
        return 'Password must be 8–200 characters.';
      default:
        return `Could not complete the request (${code}).`;
    }
  }
}
