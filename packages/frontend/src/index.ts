/**
 * @opendj/frontend — typed API client + realtime subscriber + (later) Angular
 * components for the host + guest flows.
 *
 * The `api` and `realtime` subtrees are framework-agnostic — usable from a
 * plain browser script or a React app. Angular-specific bindings (DI tokens,
 * signals wrappers) layer on top in a later commit.
 */

export * from './api/index.js';
export * from './realtime/index.js';
