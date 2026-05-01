/**
 * Runtime type guards for capability-gated provider calls.
 *
 * Each guard checks BOTH that the provider's capability descriptor declares
 * the feature as `supported: true` AND that the matching method actually
 * exists on the instance. This catches "lied in the descriptor" and "method
 * silently dropped" failure modes equally.
 *
 * See docs/agent-brief.md §"Provider Architecture" → "Type guards".
 */

import { isFeatureSupported, PROVIDER_FEATURES, type ProviderFeatureId } from './capabilities.js';
import type {
  ISupportsNowPlayingRead,
  ISupportsPause,
  ISupportsPlaylistsRead,
  ISupportsPlaylistSwitch,
  ISupportsPlaylistTracksAdd,
  ISupportsPlaylistTracksRead,
  ISupportsQueueTrack,
  ISupportsResume,
  ISupportsSearch,
  ISupportsSkipTrack,
  ISupportsVolumeRead,
  ISupportsVolumeSetAbsolute,
  ISupportsVolumeStep,
  ISupportsZonesRead,
} from './features.js';
import type { IStreamingProvider } from './IStreamingProvider.js';

function hasMethod<K extends string>(
  value: unknown,
  method: K,
): value is Record<K, (...args: unknown[]) => unknown> {
  return typeof (value as Record<string, unknown>)[method] === 'function';
}

function declaresAndImplements(
  provider: IStreamingProvider,
  featureId: ProviderFeatureId,
  method: string,
): boolean {
  return isFeatureSupported(provider.getCapabilities(), featureId) && hasMethod(provider, method);
}

export function supportsSearch(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsSearch {
  return declaresAndImplements(provider, PROVIDER_FEATURES.Search, 'search');
}

export function supportsZonesRead(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsZonesRead {
  return declaresAndImplements(provider, PROVIDER_FEATURES.ZonesRead, 'listZones');
}

export function supportsNowPlayingRead(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsNowPlayingRead {
  return declaresAndImplements(provider, PROVIDER_FEATURES.NowPlayingRead, 'getNowPlaying');
}

export function supportsQueueTrack(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsQueueTrack {
  return declaresAndImplements(provider, PROVIDER_FEATURES.QueueTrack, 'queueTrack');
}

export function supportsPlaylistSwitch(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsPlaylistSwitch {
  return declaresAndImplements(provider, PROVIDER_FEATURES.PlaylistSwitch, 'switchPlaylist');
}

export function supportsSkipTrack(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsSkipTrack {
  return declaresAndImplements(provider, PROVIDER_FEATURES.SkipTrack, 'skipTrack');
}

export function supportsPause(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsPause {
  return declaresAndImplements(provider, PROVIDER_FEATURES.Pause, 'pause');
}

export function supportsResume(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsResume {
  return declaresAndImplements(provider, PROVIDER_FEATURES.Resume, 'resume');
}

export function supportsVolumeRead(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsVolumeRead {
  return declaresAndImplements(provider, PROVIDER_FEATURES.VolumeRead, 'getVolume');
}

export function supportsVolumeSetAbsolute(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsVolumeSetAbsolute {
  return declaresAndImplements(provider, PROVIDER_FEATURES.VolumeSetAbsolute, 'setVolume');
}

export function supportsVolumeStep(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsVolumeStep {
  const capabilities = provider.getCapabilities();
  return (
    isFeatureSupported(capabilities, PROVIDER_FEATURES.VolumeStepUp) &&
    isFeatureSupported(capabilities, PROVIDER_FEATURES.VolumeStepDown) &&
    hasMethod(provider, 'increaseVolume') &&
    hasMethod(provider, 'decreaseVolume')
  );
}

export function supportsPlaylistsRead(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsPlaylistsRead {
  return declaresAndImplements(provider, PROVIDER_FEATURES.PlaylistsRead, 'listPlaylists');
}

export function supportsPlaylistTracksRead(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsPlaylistTracksRead {
  return declaresAndImplements(
    provider,
    PROVIDER_FEATURES.PlaylistTracksRead,
    'listPlaylistTracks',
  );
}

export function supportsPlaylistTracksAdd(
  provider: IStreamingProvider,
): provider is IStreamingProvider & ISupportsPlaylistTracksAdd {
  return declaresAndImplements(
    provider,
    PROVIDER_FEATURES.PlaylistTracksAdd,
    'addTracksToPlaylist',
  );
}
