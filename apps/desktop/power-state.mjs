/** Only the trusted local server can request a wake lock; renderer pages cannot. */
export function createTaskPowerState(blocker) {
  let id;
  let disposed = false;
  const release = () => {
    if (id !== undefined) { blocker.stop(id); id = undefined; }
  };
  return {
    handle(message) {
      if (disposed) return;
      if (message?.type !== 'dreamatic-power-state' || typeof message.active !== 'boolean') return;
      if (message.active) {
        if (id === undefined) id = blocker.start('prevent-app-suspension');
      } else release();
    },
    dispose() { disposed = true; release(); },
  };
}
