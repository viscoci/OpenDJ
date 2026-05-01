/**
 * @opendj/realtime — runtime-neutral realtime room contracts and the
 * in-process NodeSessionRoom implementation.
 *
 * The same RealtimeRoom interface is implemented by NodeSessionRoom (OSS)
 * and the Cloudflare Durable Object SessionRoom (opendj-live).
 *
 * See docs/agent-brief.md §"Realtime and caching architecture".
 */

export * from './types/index.js';
export * from './RealtimeRoom.js';
export * from './applyEvent.js';
export * from './NodeSessionRoom.js';
