// One MuJoCo WASM module for the whole page: the workshop and the playground
// compile their own models from it, but load the runtime only once.
import loadMujoco from '@mujoco/mujoco';
import wasmUrl from '@mujoco/mujoco/mujoco.wasm?url';

let modulePromise = null;
export function getMujoco() {
  modulePromise ??= loadMujoco({ locateFile: path => (path.endsWith('.wasm') ? wasmUrl : path) })
    .catch(error => { modulePromise = null; throw error; });
  return modulePromise;
}
