import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: { name: '@opendj/agent-tools', include: ['tests/**/*.test.ts'] },
});
