import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { name: '@opendj/db', include: ['tests/**/*.test.ts'] } });
