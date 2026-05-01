import { describe, expect, it } from 'vitest';
import {
  InvalidProviderCredentialsError,
  NotImplementedError,
  NotSupportedByProviderError,
  OpenDjError,
} from '../src/errors.js';

describe('OpenDjError', () => {
  it('uses the subclass name as Error.name', () => {
    const err = new OpenDjError('boom');
    expect(err.name).toBe('OpenDjError');
    expect(err.message).toBe('boom');
    expect(err).toBeInstanceOf(Error);
  });
});

describe('NotImplementedError', () => {
  it('formats with method only', () => {
    const err = new NotImplementedError('queueTrack');
    expect(err.name).toBe('NotImplementedError');
    expect(err.message).toBe('"queueTrack" is not implemented.');
  });

  it('formats with provider context', () => {
    const err = new NotImplementedError('queueTrack', 'apple-music');
    expect(err.message).toBe('Provider "apple-music" has not implemented "queueTrack".');
  });
});

describe('NotSupportedByProviderError', () => {
  it('exposes providerId + featureId', () => {
    const err = new NotSupportedByProviderError('spotify', 'zones.read');
    expect(err.name).toBe('NotSupportedByProviderError');
    expect(err.providerId).toBe('spotify');
    expect(err.featureId).toBe('zones.read');
    expect(err.message).toContain('spotify');
    expect(err.message).toContain('zones.read');
  });

  it('appends a reason when provided', () => {
    const err = new NotSupportedByProviderError(
      'spotify',
      'zones.read',
      'Spotify uses devices, not zones',
    );
    expect(err.message).toMatch(/Spotify uses devices/);
  });
});

describe('InvalidProviderCredentialsError', () => {
  it('exposes providerId and includes optional reason', () => {
    const err = new InvalidProviderCredentialsError('spotify', 'access_token expired');
    expect(err.providerId).toBe('spotify');
    expect(err.message).toContain('spotify');
    expect(err.message).toContain('access_token expired');
  });
});
