import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@opendj/app-shell', include: ['tests/**/*.test.ts'] },
});
