import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';

// Isolated library PoC: no SPA router, env directory, account client or network proxy.
export default defineConfig({
  base: './',
  envDir: '/tmp/treasure-island-no-env',
  plugins: [tailwindcss(), react(), {
    name: 'treasure-island-boundary-evidence',
    generateBundle() {
      const modules = [...this.getModuleIds()].sort();
      const forbidden = modules.filter(id => /\/src\/(routes\/|supabase\/|services\/(localAuth|chatStore|seqoutChat))/.test(id));
      if (forbidden.length) this.error(`Unexpected SPA dependency: ${forbidden.join(', ')}`);
      this.emitFile({ type: 'asset', fileName: 'module-inventory.json', source: JSON.stringify({ modules, forbidden }, null, 2) });
    },
  }],
  resolve: { alias: {
    '@/services/literature': resolve(import.meta.dirname, 'src/island/disabledServices.ts'),
    '@/services/seqoutChat': resolve(import.meta.dirname, 'src/island/disabledServices.ts'),
    '@/services/statsStore': resolve(import.meta.dirname, 'src/island/disabledServices.ts'),
    '@/services/petStore': resolve(import.meta.dirname, 'src/island/memoryPetStore.ts'),
    '@/lib/linkHint': resolve(import.meta.dirname, 'src/island/memoryLinkHint.ts'),
    '@/lib/treasureBurst': resolve(import.meta.dirname, 'src/island/memoryTreasureBurst.ts'),
    '@': resolve(import.meta.dirname, 'src'),
  } },
  build: {
    outDir: '/tmp/treasure-island-poc-lib', emptyOutDir: true,
    // App-mode assets retain font subsets instead of inlining the entire font into JS.
    // Strict entry exports keep the same standalone mount/update/unmount ES-module API.
    assetsInlineLimit: 0,
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/island/index.tsx'),
      preserveEntrySignatures: 'strict',
      output: { entryFileNames: 'treasure-island.js', assetFileNames: 'assets/[name]-[hash][extname]' },
    },
  },
});
