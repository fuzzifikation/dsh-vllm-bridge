import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    alias: {
      // Mirrors production resolution: the plugin imports the staged core package by bare name.
      'vllm-copilot-core': fileURLToPath(new URL('./temp/stage/vllm-copilot-core/core/index.js', import.meta.url)),
    },
  },
  test: {
    include: ['test/**/*.test.js'],
    testTimeout: 30000,
  },
})
