import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
export default defineConfig({
  base: './', plugins: [tailwindcss(), react()], envDir: '/tmp/treasure-island-no-env',
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: { outDir: '/tmp/treasure-reference-poc-dist', emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'island-reference.html') } },
});
