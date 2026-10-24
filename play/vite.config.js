import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
const api = `http://127.0.0.1:${process.env.DRAFT_API_PORT || 18382}`;
const vision = `http://127.0.0.1:${process.env.VLM_ADAPTER_PORT || 18383}`;
const port = Number(process.env.LAB_PORT || 18381);
const proxy = {'/vlm': {target: vision, rewrite: path => path.replace(/^\/vlm/, '')}, '/api': api, '/draft': api, '/training-media': api};
export default defineConfig({
  plugins: [react()],
  server: {host:'127.0.0.1', port, strictPort:true, proxy},
  preview: {host:'127.0.0.1', port, strictPort:true, proxy},
  build: {assetsDir:'bundle', chunkSizeWarningLimit:1500},
});
