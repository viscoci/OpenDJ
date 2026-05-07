/**
 * Argon2id-backed `PasswordHasher` for Node deploys.
 *
 * Uses the `argon2` native module — Node-only by design (won't install in
 * Cloudflare Workers). Workers deploys should bundle a WASM-backed adapter
 * via the same `PasswordHasher` interface from `@opendj/auth`.
 *
 * `argon2` is listed under `optionalDependencies` in `@opendj/backend` so a
 * Workers-target install can skip it without failing. The import below is
 * dynamic so backend code that doesn't touch passwords still bundles cleanly
 * for runtimes that lack the native module.
 *
 * Parameters follow OWASP 2024 guidance for Argon2id:
 *   memoryCost = 2^16 KiB (64 MiB), timeCost = 3, parallelism = 1
 *
 * Brief §"Password handling": "Default OSS Node implementation should use
 * Argon2id with per-password salts."
 */

import { detectHashAlgorithm, type PasswordHasher } from '@opendj/auth';

const DEFAULT_OPTIONS = {
  memoryCost: 64 * 1024,
  timeCost: 3,
  parallelism: 1,
};

interface ArgonModule {
  argon2id: number;
  hash(
    password: string,
    options: { type: number; memoryCost: number; timeCost: number; parallelism: number },
  ): Promise<string>;
  verify(hash: string, password: string): Promise<boolean>;
  needsRehash(
    hash: string,
    options: { memoryCost: number; timeCost: number; parallelism: number },
  ): boolean;
}

let argonModulePromise: Promise<ArgonModule> | null = null;

async function loadArgon(): Promise<ArgonModule> {
  if (argonModulePromise) return argonModulePromise;
  argonModulePromise = import('argon2').then((mod) => {
    // The argon2 package's CJS interop puts everything on `default` for ESM consumers.
    const m =
      (mod as unknown as { default?: ArgonModule }).default ?? (mod as unknown as ArgonModule);
    return m;
  }) as Promise<ArgonModule>;
  return argonModulePromise;
}

export class Argon2idPasswordHasher implements PasswordHasher {
  private readonly options: typeof DEFAULT_OPTIONS;

  constructor(options: Partial<typeof DEFAULT_OPTIONS> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  async hashPassword(password: string): Promise<string> {
    const argon = await loadArgon();
    return argon.hash(password, {
      type: argon.argon2id,
      memoryCost: this.options.memoryCost,
      timeCost: this.options.timeCost,
      parallelism: this.options.parallelism,
    });
  }

  async verifyPassword(password: string, hash: string): Promise<boolean> {
    if (detectHashAlgorithm(hash) !== 'argon2id') return false;
    const argon = await loadArgon();
    try {
      return await argon.verify(hash, password);
    } catch {
      // argon2.verify throws on malformed hashes — treat as a verification failure.
      return false;
    }
  }

  needsRehash(hash: string): boolean {
    if (detectHashAlgorithm(hash) !== 'argon2id') return true;
    // We can't await here (interface is sync). Best-effort parse: extract m=, t=, p=
    // from the hash string and compare.
    const params = parseArgonParams(hash);
    if (!params) return true;
    return (
      params.memoryCost !== this.options.memoryCost ||
      params.timeCost !== this.options.timeCost ||
      params.parallelism !== this.options.parallelism
    );
  }

  /** Algorithm identifier persisted to `password_credentials.hash_algorithm`. */
  get algorithm(): string {
    return 'argon2id';
  }
}

interface ArgonParams {
  memoryCost: number;
  timeCost: number;
  parallelism: number;
}

function parseArgonParams(hash: string): ArgonParams | null {
  // Format: $argon2id$v=19$m=65536,t=3,p=1$salt$hash
  const match = /^\$argon2id\$v=\d+\$m=(\d+),t=(\d+),p=(\d+)\$/.exec(hash);
  if (!match) return null;
  return {
    memoryCost: Number(match[1]),
    timeCost: Number(match[2]),
    parallelism: Number(match[3]),
  };
}
