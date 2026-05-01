import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@opendj/core',
    include: ['tests/**/*.test.ts'],
  },
});
