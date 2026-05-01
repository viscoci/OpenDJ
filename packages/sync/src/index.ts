/**
 * @opendj/sync — runtime-neutral song-timing primitives.
 *
 * Used by @opendj/lyrics, @opendj/realtime, and the frontend for karaoke,
 * progress bars, lighting cues, and visualizer adapters.
 *
 * See docs/agent-brief.md §"Song synchronization architecture".
 */

export * from './types.js';
export * from './normalize.js';
export * from './clock.js';
export * from './cues.js';
