import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@opendj/realtime', include: ['tests/**/*.test.ts'] },
});
