/**
 * Explicit dependency graph for the OpenDJ backend.
 *
 * Brief §"Provider registry pattern" — no decorator DI. A small typed record
 * is easier for Workers, tests, and agents to reason about than InversifyJS.
 *
 * As subsequent slices land, additional services are added here:
 * - AuthService, ClaimsService, PasswordService (auth)
 * - AbuseSignalService, RiskScoringService, RateLimitService (abuse)
 * - StreamingRouter (providers)
 * - GuestIdentityService, SlotManager, QueueService, SessionService
 * - LyricsLookupService
 * - RealtimeRoomRegistry
 */

import type { Database } from '@opendj/db';
import type { Config } from './config.js';

export interface AppDeps {
  config: Config;
  db: Database;
}

export interface CreateDepsOptions {
  config: Config;
  db: Database;
}

export function createDeps(options: CreateDepsOptions): AppDeps {
  return {
    config: options.config,
    db: options.db,
  };
}
