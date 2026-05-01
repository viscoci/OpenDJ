import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@opendj/frontend', include: ['tests/**/*.test.ts'] },
});
