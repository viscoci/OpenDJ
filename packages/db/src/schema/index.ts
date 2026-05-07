/**
 * Drizzle schema for OpenDJ.
 *
 * Includes the foundation tables. Commercial extensions like `subscriptions`
 * or product/funnel analytics dashboards belong in downstream consumer
 * migrations, not here. `action_events` and `abuse_subjects` ARE included
 * because abuse prevention is core product safety, not business analytics.
 */

export * from './users.js';
export * from './accounts.js';
export * from './auth.js';
export * from './providers.js';
export * from './sessions.js';
export * from './lyrics.js';
export * from './abuse.js';
