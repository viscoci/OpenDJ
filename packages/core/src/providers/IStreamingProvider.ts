/**
 * Base contract for all streaming providers.
 *
 * Providers implement IStreamingProvider plus only the modular ISupports*
 * interfaces (see ./features.ts) that they actually support. Routes and UI
 * gate on capability descriptors and the type guards in ./guards.ts before
 * calling feature-specific methods.
 *
 * See docs/agent-brief.md §"Provider Architecture".
 */

import type { ProviderCredentials } from '../types/index.js';
import type { ProviderCapabilities, ProviderId } from './capabilities.js';

export interface IStreamingProvider {
  readonly providerId: ProviderId;
  readonly displayName: string;

  connect(credentials: ProviderCredentials): Promise<void>;
  disconnect(): Promise<void>;
  isConnected(): boolean;
  refreshCredentials(): Promise<ProviderCredentials>;

  /**
   * Returns the static capability map for this provider.
   *
   * Implementations should declare the descriptor for every feature they
   * support, plus any unsupported feature where there's a useful note (e.g.
   * "Spotify has devices, not OpenDJ zones"). Omitting an entry and declaring
   * `supported: false` are equivalent for gating, but the explicit form
   * documents the boundary for downstream consumers.
   */
  getCapabilities(): ProviderCapabilities;
}
