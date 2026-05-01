import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@opendj/abuse', include: ['tests/**/*.test.ts'] } });
