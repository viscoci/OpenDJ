/**
 * @opendj/abuse — runtime-neutral abuse-prevention primitives.
 *
 * Pure types + decision helpers + service interfaces. Concrete implementations
 * (rolling-window risk scoring, rate-limit storage) live in @opendj/backend.
 *
 * See docs/agent-brief.md §"Abuse prevention and backend analytics".
 */

export * from './types/index.js';
export * from './services.js';
