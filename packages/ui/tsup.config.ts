import { defineConfig } from 'tsup';

export default defineConfig((options) => ({
  entry: ['src/index.tsx'],
  format: ['cjs', 'esm'],
  dts: true,
  clean: !options.watch,
  sourcemap: true,
  external: ['react', 'react-dom'],
}));
