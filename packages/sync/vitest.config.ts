import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@opendj/sync', include: ['tests/**/*.test.ts'] } });
