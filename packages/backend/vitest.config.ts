import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@opendj/backend', include: ['tests/**/*.test.ts'] } });
