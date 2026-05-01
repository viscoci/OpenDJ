import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@opendj/auth', include: ['tests/**/*.test.ts'] } });
