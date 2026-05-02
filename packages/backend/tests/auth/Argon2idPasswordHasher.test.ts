import { describe, expect, it } from 'vitest';
import { Argon2idPasswordHasher } from '../../src/auth/Argon2idPasswordHasher.js';

describe('Argon2idPasswordHasher', () => {
  it('hashPassword produces an argon2id-tagged hash', async () => {
    const hasher = new Argon2idPasswordHasher();
    const hash = await hasher.hashPassword('correct horse battery staple');
    expect(hash).toMatch(/^\$argon2id\$/);
  });

  it('verifyPassword returns true for the matching password', async () => {
    const hasher = new Argon2idPasswordHasher();
    const hash = await hasher.hashPassword('correct horse battery staple');
    expect(await hasher.verifyPassword('correct horse battery staple', hash)).toBe(true);
  });

  it('verifyPassword returns false for the wrong password', async () => {
    const hasher = new Argon2idPasswordHasher();
    const hash = await hasher.hashPassword('correct horse battery staple');
    expect(await hasher.verifyPassword('something else', hash)).toBe(false);
  });

  it('verifyPassword returns false (not throws) on a malformed hash', async () => {
    const hasher = new Argon2idPasswordHasher();
    expect(await hasher.verifyPassword('whatever', '$argon2id$bogus')).toBe(false);
  });

  it('verifyPassword returns false on a non-argon2id hash', async () => {
    const hasher = new Argon2idPasswordHasher();
    expect(await hasher.verifyPassword('whatever', '$2b$10$something')).toBe(false);
  });

  it('needsRehash returns true for unrecognized algorithms', () => {
    const hasher = new Argon2idPasswordHasher();
    expect(hasher.needsRehash('plain-text')).toBe(true);
    expect(hasher.needsRehash('$2b$10$abc')).toBe(true);
  });

  it('needsRehash returns false for hashes matching current parameters', async () => {
    const hasher = new Argon2idPasswordHasher();
    const hash = await hasher.hashPassword('pw');
    expect(hasher.needsRehash(hash)).toBe(false);
  });

  it('needsRehash returns true when parameters differ', async () => {
    const lower = new Argon2idPasswordHasher({ memoryCost: 32 * 1024 });
    const hash = await lower.hashPassword('pw');
    const stricter = new Argon2idPasswordHasher({ memoryCost: 64 * 1024 });
    expect(stricter.needsRehash(hash)).toBe(true);
  });

  it('exposes the algorithm identifier for password_credentials.hash_algorithm', () => {
    expect(new Argon2idPasswordHasher().algorithm).toBe('argon2id');
  });
});
