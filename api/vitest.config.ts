import { defineConfig } from 'vitest/config';

// Test files share one scratch database, so run them one after another.
export default defineConfig({ test: { fileParallelism: false } });
