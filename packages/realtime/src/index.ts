/**
 * @opendj/realtime — runtime-neutral realtime room contracts.
 *
 * The same RealtimeRoom interface is implemented by NodeSessionRoom (OSS)
 * and the Cloudflare Durable Object SessionRoom (opendj-live).
 *
 * See docs/agent-brief.md §"Realtime and caching architecture".
 */

export * from './types/index.js';
export * from './RealtimeRoom.js';
