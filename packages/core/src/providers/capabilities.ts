/**
 * Provider feature catalog and capability descriptors.
 *
 * The PROVIDER_FEATURES constant gives stable string IDs that backend routes,
 * frontend controls, docs, and tests can share as a single vocabulary.
 *
 * See docs/agent-brief.md §"Provider Architecture" → "Feature IDs".
 */

export type ProviderId = 'spotify' | 'soundtrack' | 'apple-music' | (string & {});

export const PROVIDER_FEATURES = {
  Search: 'search',
  NowPlayingRead: 'now_playing.read',
  PlaybackProgressRead: 'playback.progress.read',
  QueueTrack: 'queue.track',
  PlaylistSwitch: 'playlist.switch',
  SkipTrack: 'playback.skip',
  Pause: 'playback.pause',
  Resume: 'playback.resume',
  VolumeRead: 'volume.read',
  VolumeSetAbsolute: 'volume.set_absolute',
  VolumeStepUp: 'volume.step_up',
  VolumeStepDown: 'volume.step_down',
  ZonesRead: 'zones.read',
  ZoneSelect: 'zones.select',
  DevicesRead: 'devices.read',
  DeviceTransferPlayback: 'devices.transfer_playback',
  PlaylistsRead: 'playlists.read',
  PlaylistsCreate: 'playlists.create',
  PlaylistTracksRead: 'playlist_tracks.read',
  PlaylistTracksAdd: 'playlist_tracks.add',
  PlaylistTracksRemove: 'playlist_tracks.remove',
  LibraryTracksRead: 'library_tracks.read',
  LyricsRead: 'lyrics.read',
  SyncClockRead: 'sync.clock.read',
} as const;

export type ProviderFeatureId = (typeof PROVIDER_FEATURES)[keyof typeof PROVIDER_FEATURES];

/**
 * Who is allowed to invoke this feature.
 *
 * - guest: any authenticated session guest can call (e.g. search)
 * - host: only host with appropriate claim (e.g. skip)
 * - account: any account member with appropriate claim (e.g. provider:connect)
 * - internal: only OpenDJ services may call (not exposed to UI)
 */
export type ProviderFeatureAccess = 'guest' | 'host' | 'account' | 'internal';

/**
 * How the feature is implemented for this provider.
 *
 * - native: provider exposes this directly
 * - emulated: implemented via composition of lower-level provider APIs
 * - best_effort: works but with caveats (latency, drift, partial support)
 * - unsupported: cannot be implemented; capability descriptor.supported === false
 */
export type ProviderFeatureReliability = 'native' | 'emulated' | 'best_effort' | 'unsupported';

export interface ProviderFeatureDescriptor {
  id: ProviderFeatureId;
  supported: boolean;
  access: ProviderFeatureAccess;
  reliability?: ProviderFeatureReliability;
  notes?: string;
}

export interface ProviderCapabilities {
  providerId: ProviderId;
  features: Partial<Record<ProviderFeatureId, ProviderFeatureDescriptor>>;
}

/**
 * Helper for building a ProviderCapabilities map. Validates that each entry's
 * descriptor `id` matches its key, catching copy/paste mistakes at construction.
 */
export function defineCapabilities(
  providerId: ProviderId,
  features: Partial<Record<ProviderFeatureId, ProviderFeatureDescriptor>>,
): ProviderCapabilities {
  for (const [key, descriptor] of Object.entries(features)) {
    if (descriptor && descriptor.id !== key) {
      throw new Error(`Capability descriptor for "${key}" has mismatched id "${descriptor.id}".`);
    }
  }
  return { providerId, features };
}

/**
 * Returns the descriptor for a feature, or undefined if the provider has not
 * declared it. Convenience wrapper around the raw record access.
 */
export function getFeatureDescriptor(
  capabilities: ProviderCapabilities,
  featureId: ProviderFeatureId,
): ProviderFeatureDescriptor | undefined {
  return capabilities.features[featureId];
}

/**
 * True iff the provider has declared the feature with `supported: true`.
 *
 * Note: this only checks the descriptor. The runtime type guards in `guards.ts`
 * additionally verify that the matching method exists on the provider instance.
 */
export function isFeatureSupported(
  capabilities: ProviderCapabilities,
  featureId: ProviderFeatureId,
): boolean {
  return capabilities.features[featureId]?.supported === true;
}
