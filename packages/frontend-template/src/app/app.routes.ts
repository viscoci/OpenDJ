import type { Routes } from '@angular/router';
import { GuestRequestPage } from './pages/guest-request.page';
import { LandingPage } from './pages/landing.page';

export const routes: Routes = [
  { path: '', component: LandingPage, pathMatch: 'full' },
  { path: 'u/:slug', component: GuestRequestPage },
];
