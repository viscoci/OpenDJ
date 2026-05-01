/**
 * @opendj/lyrics — runtime-neutral lyrics primitives + LRCLIB adapter.
 *
 * Day-one feature for OpenDJ live/TV view. Lyrics enrich the experience but
 * never block queue operations — lookup runs in the background after
 * now-playing changes.
 *
 * See docs/agent-brief.md §"Lyrics and karaoke" + §"LRCLIB adapter".
 */

export * from './types.js';
export * from './lookup-key.js';
export * from './lrc-parser.js';
export * from './sync-cues.js';
export * from './providers/index.js';
