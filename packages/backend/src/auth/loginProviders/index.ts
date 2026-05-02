/**
 * Default login-provider registry. Add a new provider by registering its
 * `LoginProviderHandler` here (or pass a custom registry to `createDeps`).
 */

import { AppleLoginHandler } from './apple.js';
import { FacebookLoginHandler } from './facebook.js';
import { GoogleLoginHandler } from './google.js';
import type { LoginProviderHandler } from './types.js';

export type LoginProviderRegistry = Readonly<Record<string, LoginProviderHandler>>;

export function createDefaultLoginProviderRegistry(): LoginProviderRegistry {
  return {
    google: new GoogleLoginHandler(),
    apple: new AppleLoginHandler(),
    facebook: new FacebookLoginHandler(),
  };
}

export * from './types.js';
export * from './google.js';
export * from './apple.js';
export * from './facebook.js';
