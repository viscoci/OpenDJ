/**
 * Apple Music provider — stub.
 *
 * MusicKit JS is browser-oriented; a server-side Apple Music provider needs
 * a meaningful design (developer token signing, Music user tokens, etc.) that
 * isn't worth scaffolding before someone needs it. Every feature method
 * throws `NotImplementedError`. Capabilities report `supported: false`.
 *
 * See docs/agent-brief.md §"Providers to implement" → Apple Music.
 */

import {
  defineCapabilities,
  NotImplementedError,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ProviderCapabilities,
  type ProviderCredentials,
} from '@opendj/core';

const capabilities: ProviderCapabilities = defineCapabilities('apple-music', {
  [PROVIDER_FEATURES.Search]: {
    id: PROVIDER_FEATURES.Search,
    supported: false,
    access: 'guest',
    reliability: 'unsupported',
    notes: 'Apple Music server-side stub. Use MusicKit JS in the browser for now.',
  },
});

export class AppleMusicProvider implements IStreamingProvider {
  readonly providerId = 'apple-music';
  readonly displayName = 'Apple Music';

  async connect(_credentials: ProviderCredentials): Promise<void> {
    throw new NotImplementedError('connect', this.providerId);
  }

  async disconnect(): Promise<void> {
    // No-op; nothing to release.
  }

  isConnected(): boolean {
    return false;
  }

  async refreshCredentials(): Promise<ProviderCredentials> {
    throw new NotImplementedError('refreshCredentials', this.providerId);
  }

  getCapabilities(): ProviderCapabilities {
    return capabilities;
  }
}
