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
import { DrizzleMembershipRepository } from './memberships.js';
import { DrizzleOAuthStateRepository } from './oauth-states.js';
import { DrizzlePasswordCredentialRepository } from './password-credentials.js';
import { DrizzleProviderConnectionRepository } from './provider-connections.js';
import { DrizzleUserRepository } from './users.js';

export * from './users.js';
export * from './accounts.js';
export * from './memberships.js';
export * from './auth-identities.js';
export * from './auth-sessions.js';
export * from './oauth-states.js';
export * from './password-credentials.js';
export * from './provider-connections.js';

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
  };
}
