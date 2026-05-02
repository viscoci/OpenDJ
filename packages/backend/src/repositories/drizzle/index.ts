/**
 * Drizzle-backed repository implementations. Use these in production via
 * `createDrizzleRepositories(db)`. Tests use the in-memory implementations
 * from `../in-memory/`.
 */

import type { Database } from '@opendj/db';
import type { Repositories } from '../types.js';
import { DrizzleAccountRepository } from './accounts.js';
import { DrizzleAuthIdentityRepository } from './auth-identities.js';
import { DrizzleAuthSessionRepository } from './auth-sessions.js';
import { DrizzleFingerprintPriorityRepository } from './fingerprint-priority.js';
import { DrizzleGuestRepository } from './guests.js';
import { DrizzleGuestSlotRepository } from './guest-slots.js';
import { DrizzleLyricsCacheRepository } from './lyrics-cache.js';
import { DrizzleLyricsFeedbackRepository } from './lyrics-feedback.js';
import { DrizzleMembershipRepository } from './memberships.js';
import { DrizzleOAuthStateRepository } from './oauth-states.js';
import { DrizzlePasswordCredentialRepository } from './password-credentials.js';
import { DrizzleProviderConnectionRepository } from './provider-connections.js';
import { DrizzleQueueItemRepository } from './queue-items.js';
import { DrizzleSessionRepository } from './sessions.js';
import { DrizzleUserRepository } from './users.js';

export * from './users.js';
export * from './accounts.js';
export * from './memberships.js';
export * from './auth-identities.js';
export * from './auth-sessions.js';
export * from './fingerprint-priority.js';
export * from './guests.js';
export * from './guest-slots.js';
export * from './lyrics-cache.js';
export * from './lyrics-feedback.js';
export * from './oauth-states.js';
export * from './password-credentials.js';
export * from './provider-connections.js';
export * from './queue-items.js';
export * from './sessions.js';

export function createDrizzleRepositories(db: Database): Repositories {
  return {
    users: new DrizzleUserRepository(db),
    accounts: new DrizzleAccountRepository(db),
    memberships: new DrizzleMembershipRepository(db),
    authIdentities: new DrizzleAuthIdentityRepository(db),
    authSessions: new DrizzleAuthSessionRepository(db),
    passwordCredentials: new DrizzlePasswordCredentialRepository(db),
    oauthStates: new DrizzleOAuthStateRepository(db),
    providerConnections: new DrizzleProviderConnectionRepository(db),
    sessions: new DrizzleSessionRepository(db),
    guests: new DrizzleGuestRepository(db),
    guestSlots: new DrizzleGuestSlotRepository(db),
    fingerprintPriority: new DrizzleFingerprintPriorityRepository(db),
    queueItems: new DrizzleQueueItemRepository(db),
    lyricsCache: new DrizzleLyricsCacheRepository(db),
    lyricsFeedback: new DrizzleLyricsFeedbackRepository(db),
  };
}
