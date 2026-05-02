import type { Routes } from '@angular/router';
import { hostGuard } from './guards/host.guard';
import { GuestRequestPage } from './pages/guest-request.page';
import { HostDashboardPage } from './pages/host/host-dashboard.page';
import { HostLoginPage } from './pages/host/host-login.page';
import { HostSessionPage } from './pages/host/host-session.page';
import { LandingPage } from './pages/landing.page';

export const routes: Routes = [
  { path: '', component: LandingPage, pathMatch: 'full' },
  { path: 'u/:slug', component: GuestRequestPage },
  { path: 'host', pathMatch: 'full', redirectTo: 'host/dashboard' },
  { path: 'host/login', component: HostLoginPage },
  { path: 'host/dashboard', component: HostDashboardPage, canActivate: [hostGuard] },
  { path: 'host/sessions/:id', component: HostSessionPage, canActivate: [hostGuard] },
];
