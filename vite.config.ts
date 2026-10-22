import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
export default defineConfig({
  root: 'src/panel', base: './', plugins: [react()],
  define: {
    __CUE_TOKEN__: JSON.stringify(readFileSync('.cue-token', 'utf8').trim()),
    // Stamped at build time so the panel can prove which build it is running.
    __CUE_BUILT__: JSON.stringify(new Date().toISOString()),
  },
  build: { outDir: '../../outputs/extension', emptyOutDir: true, target: 'chrome120' },
});
