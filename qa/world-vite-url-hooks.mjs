// Node module hooks for headless QA: Vite's `?url` asset imports (e.g. the
// ONNX Runtime WASM URL) have no meaning in Node, where QA injects ORT and its
// session directly. Resolve them to a stub string so browser modules such as
// play/src/creature-controller.js import unchanged, relative imports intact.
export async function resolve(specifier, context, nextResolve) {
  if (/\?url$/.test(specifier)) return { url: `data:text/javascript,export default ${JSON.stringify(`node-stub:${specifier}`)}`, shortCircuit: true };
  return nextResolve(specifier, context);
}
