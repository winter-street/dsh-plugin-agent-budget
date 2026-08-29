import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  dts: true,
  sourcemap: true,
  clean: true,
  fixedExtension: false,
  deps: {
    neverBundle: [/^@deepseek-ai\//],
  },
})
