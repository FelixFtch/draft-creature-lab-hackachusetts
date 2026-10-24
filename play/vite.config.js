import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
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

// `vite build --mode demo` makes the backend-free web demo in dist-demo/: relative
// base (works under any sub-path, e.g. GitHub Pages), plus the static snapshot in
// demo/static/ and the creature files those snapshots list. src/demo/shim.js maps
// the service URLs onto these files at runtime. The normal build is unchanged.
const here = dirname(fileURLToPath(import.meta.url));
function demoStatic() {
  let outDir = '';
  return {
    name: 'draft-demo-static',
    apply: 'build',
    configResolved(config) { outDir = resolve(config.root, config.build.outDir); },
    closeBundle() {
      cpSync(resolve(here, 'demo/static'), outDir, { recursive: true });
      const { bodies = [] } = JSON.parse(readFileSync(resolve(here, 'demo/static/demo-api/api/bodies.json'), 'utf8'));
      for (const { id } of bodies) {
        const source = resolve(here, '../creatures', id);
        if (existsSync(source)) cpSync(source, resolve(outDir, 'creatures', id), { recursive: true });
      }
    },
  };
}

// Hosts with a strict content-security policy allow WebAssembly
// ('wasm-unsafe-eval') but not string evaluation ('unsafe-eval'). MuJoCo's
// embind glue builds each binding with `new Function`; the demo swaps that one
// line for an equivalent closure (the DYNAMIC_EXECUTION=0 form of the invoker).
const EMBIND_EVAL = 'var invokerFn = new Function(...args, invokerFnBody)(...closureArgs);';
const EMBIND_CLOSURE = `var invokerFn = function(...callArgs) {
        checkArgCount(callArgs.length, minArgs, expectedArgCount, humanName, throwBindingError);
        var destructors = needsDestructorStack ? [] : null, wired = [cppTargetFunc], offset = isClassMethodFunc ? 2 : 1, thisWired;
        if (isClassMethodFunc) { thisWired = argTypes[1]['toWireType'](destructors, this); wired.push(thisWired); }
        for (var i = 0; i < expectedArgCount; ++i) wired.push(argTypes[i + 2]['toWireType'](destructors, callArgs[i]));
        var rv = cppInvokerFunc(...wired);
        if (needsDestructorStack) runDestructors(destructors);
        else for (var j = isClassMethodFunc ? 1 : 2; j < argTypes.length; ++j) {
          if (argTypes[j].destructorFunction !== null) argTypes[j].destructorFunction(j === 1 ? thisWired : wired[j - 2 + offset]);
        }
        if (returns) return argTypes[0]['fromWireType'](rv);
      };`;
function demoNoEval() {
  return {
    name: 'draft-demo-no-eval',
    transform(code, id) {
      if (!id.replace(/\\/g, '/').endsWith('@mujoco/mujoco/mujoco.js')) return null;
      if (!code.includes(EMBIND_EVAL)) this.error('MuJoCo embind invoker changed; update demoNoEval in vite.config.js');
      return { code: code.replace(EMBIND_EVAL, EMBIND_CLOSURE), map: null };
    },
  };
}

export default defineConfig(({ mode }) => {
  const demo = mode === 'demo';
  return {
    plugins: [react(), demo && demoStatic(), demo && demoNoEval()],
    base: demo ? './' : '/',
    server: { host: '127.0.0.1', port, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port, strictPort: true, proxy },
    build: { assetsDir: 'bundle', chunkSizeWarningLimit: 1500, ...(demo ? { outDir: 'dist-demo', emptyOutDir: true } : {}) },
  };
});
