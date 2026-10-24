// Web demo only (`vite build --mode demo`). There are no local services, so this
// wraps fetch: absolute service paths (/api, /ai, /vlm) answer from the static
// snapshot in demo-api/, and absolute asset paths (/creatures, /controller,
// /draft, ...) become relative, so the build runs from any sub-path. Designing,
// training and Tinker chat need the local install and fail with a clear message.
export const DEMO_MESSAGE = 'Designing and training need the local install — see the README.';
const CHAT_MESSAGE = 'Chatting with Tinker needs the local install — see the README.';
const VISION_MESSAGE = 'Explore mode needs the local vision service — see the README.';

const json = (status, value) => new Response(JSON.stringify(value), { status, headers: { 'Content-Type': 'application/json' } });
const refuse = message => json(503, { error: message, message, demo: true });

export function installDemo() {
  if (globalThis.__draftDemo) return;
  globalThis.__draftDemo = true;
  const realFetch = globalThis.fetch.bind(globalThis);
  const local = path => new URL(path, document.baseURI).href;

  function staticTarget(path) {
    if (path === '/ai/health' || path === '/vlm/health') return local('demo-api/ai/health.json');
    if (path === '/api/training/jobs/current') return local('demo-api/api/training-current.json');
    const policies = path.match(/^\/api\/creatures\/([a-z0-9-]+)\/policies$/);
    if (policies) return local(`demo-api/api/creatures/${policies[1]}/policies.json`);
    if (/^\/api\/(catalog|bodies|flower-status|training-status)$/.test(path)) return local(`demo-api${path}.json`);
    if (/^\/(api|ai|vlm)\//.test(path)) return null;
    return local(path.replace(/^\/+/, ''));
  }

  async function demoFetch(input, init = {}) {
    const raw = typeof input === 'string' ? input : null;
    // Only absolute same-site paths are remapped; relative and full URLs (the
    // bundle's own wasm and chunks) pass straight through.
    if (!raw || !raw.startsWith('/') || raw.startsWith('//')) return realFetch(input, init);
    const path = raw.split(/[?#]/)[0];
    const method = String(init.method || 'GET').toUpperCase();
    if (method === 'GET' || method === 'HEAD') {
      const target = staticTarget(path);
      return target ? realFetch(target, init) : refuse(DEMO_MESSAGE);
    }
    if (path === '/api/generate') {
      let body = {};
      try { body = JSON.parse(init.body || '{}'); } catch { /* refused below */ }
      const original = (body.lengthScale ?? 1) === 1 && (body.legScale ?? 1) === 1;
      if (original && /^[a-z]+$/.test(body.preset || '')) return realFetch(local(`demo-api/api/generate/${body.preset}.json`), { signal: init.signal });
      return refuse(DEMO_MESSAGE);
    }
    if (path.startsWith('/ai/')) return refuse(CHAT_MESSAGE);
    if (path.startsWith('/vlm/')) return refuse(VISION_MESSAGE);
    return refuse(DEMO_MESSAGE);
  }
  globalThis.fetch = demoFetch;

  const note = document.createElement('div');
  note.className = 'draft-demo-note';
  note.setAttribute('role', 'note');
  note.textContent = 'Web demo · designing and training need the local install';
  // Sits in the strip above the top bar, clear of the app's own controls.
  Object.assign(note.style, {
    position: 'fixed', left: 'calc(24px + env(safe-area-inset-left, 0px))', top: 'calc(3px + env(safe-area-inset-top, 0px))',
    zIndex: '40', pointerEvents: 'none', padding: '1px 8px', borderRadius: '999px',
    font: '600 10px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif', letterSpacing: '.02em',
    color: '#f6f3e9', background: 'rgba(28, 34, 38, .72)', opacity: '.9',
  });
  document.body.appendChild(note);
}
