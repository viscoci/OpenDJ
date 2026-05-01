/**
 * Soundtrack Your Brand provider — P1 stub.
 *
 * Soundtrack is a commercial venue-friendly provider that exposes playlist
 * switching, zones, and now-playing via GraphQL. Full implementation lands in
 * a follow-up commit. Capabilities are pre-declared so route-gating works
 * once the methods are filled in.
 *
 * See docs/agent-brief.md §"Providers to implement" → Soundtrack.
 */

import {
  defineCapabilities,
  NotImplementedError,
  PROVIDER_FEATURES,
  type IStreamingProvider,
  type ProviderCapabilities,
  type ProviderCredentials,
} from '@opendj/core';

const capabilities: ProviderCapabilities = defineCapabilities('soundtrack', {
  [PROVIDER_FEATURES.Search]: {
    id: PROVIDER_FEATURES.Search,
    supported: false,
    access: 'guest',
    reliability: 'unsupported',
    notes: 'Soundtrack stub — implementation pending.',
  },
  [PROVIDER_FEATURES.PlaylistSwitch]: {
    id: PROVIDER_FEATURES.PlaylistSwitch,
    supported: false,
    access: 'host',
    reliability: 'unsupported',
    notes: 'Soundtrack stub — implementation pending.',
  },
  [PROVIDER_FEATURES.NowPlayingRead]: {
    id: PROVIDER_FEATURES.NowPlayingRead,
    supported: false,
    access: 'guest',
    reliability: 'unsupported',
    notes: 'Soundtrack stub — implementation pending.',
  },
  [PROVIDER_FEATURES.ZonesRead]: {
    id: PROVIDER_FEATURES.ZonesRead,
    supported: false,
    access: 'host',
    reliability: 'unsupported',
    notes: 'Soundtrack stub — implementation pending.',
  },
});

export class SoundtrackProvider implements IStreamingProvider {
  readonly providerId = 'soundtrack';
  readonly displayName = 'Soundtrack Your Brand';

  async connect(_credentials: ProviderCredentials): Promise<void> {
    throw new NotImplementedError('connect', this.providerId);
  }

  async disconnect(): Promise<void> {
    // No-op.
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
