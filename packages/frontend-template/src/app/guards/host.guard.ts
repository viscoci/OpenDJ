import { inject } from '@angular/core';
import { Router, type CanActivateFn } from '@angular/router';
import { AuthService } from '../services/auth.service.js';

/**
 * Route guard for host-only pages. Resolves auth state if not yet known,
 * then permits/denies based on the result.
 *
 * On 401 redirects to `/host/login` and preserves the intended path via
 * `queryParams.redirectTo` for post-login bounce-back.
 */
export const hostGuard: CanActivateFn = async (_route, state) => {
  const auth = inject(AuthService);
  const router = inject(Router);
  let current = auth.state();
  if (current.kind === 'unknown') {
    current = await auth.refresh();
  }
  if (current.kind === 'authenticated') return true;
  return router.createUrlTree(['/host/login'], {
    queryParams: { redirectTo: state.url },
  });
};
