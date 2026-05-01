/**
 * Streaming provider registry.
 *
 * `providerRegistry` is a plain Record mapping `providerId` → factory function.
 * No decorators, no Inversify — easier for Workers, tests, and agents to
 * reason about. Brief §"Provider registry pattern".
 */

import type { IStreamingProvider } from '@opendj/core';

/**
 * Context handed to each provider factory at construction time. Concrete
 * providers (e.g. Spotify) capture what they need. Stub providers ignore
 * everything except `fetch`.
 *
 * Workers can pass their own `fetch` here (e.g. for outbound binding); Node
 * uses `globalThis.fetch`.
 */
export interface ProviderContext {
  fetch: typeof fetch;
}

export type ProviderFactory = (ctx: ProviderContext) => IStreamingProvider;

export type ProviderRegistry = Readonly<Record<string, ProviderFactory>>;
