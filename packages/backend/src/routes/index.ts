/**
 * Public re-exports for routes that need to be mounted by external apps
 * (e.g. apps/oss-demo) that want to wire the realtime route after building
 * their own WebSocket adapter on the same Hono instance createApp returns.
 */

export { realtimeRoutes, type UpgradeWebSocket } from './realtime.js';
