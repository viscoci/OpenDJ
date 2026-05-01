/**
 * Standard error types raised by OpenDJ providers and feature gates.
 *
 * Backend route handlers should map these to HTTP responses:
 * - NotSupportedByProviderError → 501 not_supported_by_provider
 * - NotImplementedError → 501 (typically only seen in stub providers)
 * - InvalidProviderCredentialsError → 401
 *
 * See docs/agent-brief.md §"Provider Architecture" → "Provider behavior rules".
 */

export class OpenDjError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
  }
}

export class NotImplementedError extends OpenDjError {
  constructor(method: string, providerId?: string) {
    super(
      providerId
        ? `Provider "${providerId}" has not implemented "${method}".`
        : `"${method}" is not implemented.`,
    );
  }
}

export class NotSupportedByProviderError extends OpenDjError {
  readonly providerId: string;
  readonly featureId: string;

  constructor(providerId: string, featureId: string, reason?: string) {
    super(
      reason
        ? `Provider "${providerId}" does not support feature "${featureId}": ${reason}`
        : `Provider "${providerId}" does not support feature "${featureId}".`,
    );
    this.providerId = providerId;
    this.featureId = featureId;
  }
}

export class InvalidProviderCredentialsError extends OpenDjError {
  readonly providerId: string;

  constructor(providerId: string, reason?: string) {
    super(
      reason
        ? `Invalid credentials for provider "${providerId}": ${reason}`
        : `Invalid credentials for provider "${providerId}".`,
    );
    this.providerId = providerId;
  }
}
