// A held pointer/key owns one manual command. Async controller loading cannot
// revive a released gesture or transfer it to a replacement body.
export function createDriveInput({ getContext, onPending = () => {}, onError = () => {}, onInvalidated = () => {} }) {
  let generation = 0, session = null;
  const validCommand = value => Array.isArray(value) && value.length === 3 && value.every(Number.isFinite);
  const bodyMatches = item => {
    const context = getContext();
    return context.lab === item.lab && context.lab?.snapshot?.().modelId === item.modelId;
  };
  const valid = item => session === item && item.generation === generation && getContext().allowed && bodyMatches(item);
  function cancel({ sendZero = true, stopPending = true } = {}) {
    const old = session;
    ++generation; session = null; onPending(false);
    if (!old || !bodyMatches(old)) return;
    try {
      if (old.starting && stopPending) old.lab.stopWalking();
      else if (sendZero) old.lab.setDriveCommand([0, 0, 0]);
    } catch (error) { onError(error); }
  }
  function invalidate() { cancel({ sendZero: false, stopPending: false }); onInvalidated(); }
  function apply(item) {
    if (!valid(item) || !item.lab.snapshot().walking?.active) { if (session === item) invalidate(); return; }
    item.lab.setDriveCommand(item.command);
  }
  async function begin(command) {
    if (!validCommand(command)) throw Error('Expected a finite drive command');
    cancel();
    const context = getContext(), lab = context.lab;
    if (!context.allowed || !lab?.startWalking || !lab?.setDriveCommand || !lab?.snapshot) return;
    let before = lab.snapshot();
    if (before.walking?.loading && before.vision?.active && typeof lab.stopVision === 'function') {
      try { lab.stopVision('manual'); before = lab.snapshot(); }
      catch (error) { onError(error); onInvalidated(); return; }
    }
    if (before.walking?.loading) { onError(Error('Wait for the walking controller to finish loading')); return; }
    const item = { generation: ++generation, lab, modelId: before.modelId, command: [...command], starting: false };
    session = item;
    try {
      // Manual input takes over a visual decision or route guide immediately.
      lab.setDriveCommand([0, 0, 0]);
      if (!lab.snapshot().walking?.active) {
        item.starting = true; onPending(true);
        await lab.startWalking();
        if (!valid(item)) { if (session === item) invalidate(); return; }
        item.starting = false; onPending(false);
      }
      apply(item);
    } catch (error) {
      if (session === item && item.generation === generation) { cancel(); onError(error); onInvalidated(); }
    }
  }
  function update(command) {
    if (!validCommand(command)) throw Error('Expected a finite drive command');
    const item = session;
    if (!item) return;
    if (!valid(item)) { invalidate(); return; }
    item.command = [...command];
    if (!item.starting) {
      try { apply(item); } catch (error) { cancel(); onError(error); onInvalidated(); }
    }
  }
  return { begin, update, cancel, release: () => cancel(), hasSession: () => !!session, isStarting: () => !!session?.starting };
}
