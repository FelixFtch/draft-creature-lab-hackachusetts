import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const api = `http://127.0.0.1:${process.env.DRAFT_API_PORT || 18382}`;
const ai = `http://127.0.0.1:${process.env.AI_SERVICE_PORT || process.env.VLM_ADAPTER_PORT || 18383}`;
const port = Number(process.env.LAB_PORT || 18381);
// Generated bodies, policies and training media are created at runtime, so they
// are served by draft-service rather than from the build's public folder.
// ai-service is reached as /ai/<route>; /vlm/<route> stays for the original
// vision adapter contract.
const proxy = {
  '^/ai/': { target: ai, rewrite: path => path.replace(/^\/ai/, '') },
  '^/vlm/': { target: ai, rewrite: path => path.replace(/^\/vlm/, '') },
  '/api': api,
  '/draft': api,
  '/creatures': api,
  '/training-media': api,
};
export default defineConfig({
  plugins: [react()],
  server: { host: '127.0.0.1', port, strictPort: true, proxy },
  preview: { host: '127.0.0.1', port, strictPort: true, proxy },
  build: { assetsDir: 'bundle', chunkSizeWarningLimit: 1500 },
});
