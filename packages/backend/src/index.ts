/**
 * @opendj/backend — Hono routes and services for OpenDJ.
 *
 * Run from Node (apps/oss-demo) and Cloudflare Workers (opendj-live/apps/api)
 * via the same createApp factory.
 *
 * See docs/agent-brief.md §"Backend package directory structure" + §"API Routes".
 */

export * from './app.js';
export * from './config.js';
export * from './deps.js';
export * from './abuse/index.js';
export * from './auth/index.js';
export * from './guest/index.js';
export * from './lyrics/index.js';
export * from './providers/index.js';
export * from './queue/index.js';
export * from './repositories/index.js';
export * from './session/index.js';
