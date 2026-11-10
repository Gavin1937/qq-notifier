/**
 * Graceful shutdown that always terminates the process.
 *
 * Background SDK clients (websocket, token refresher, reconnect timers) can keep
 * Node's event loop alive after every component has been stopped, which is why
 * the process is exited explicitly instead of relying on an empty handle list.
 * A timeout guarantees termination even if a stop() never settles.
 */
export async function shutdown({
  supervisor,
  worker,
  sender,
  listeners,
  db,
  logger,
  timeoutMs = 5000,
  exit = (code) => process.exit(code),
  setTimer = setTimeout,
  clearTimer = clearTimeout
} = {}) {
  let timedOut = false;
  let timerHandle;
  const timeout = new Promise((resolve) => {
    timerHandle = setTimer(() => {
      timedOut = true;
      resolve();
    }, timeoutMs);
    timerHandle?.unref?.();
  });

  const work = (async () => {
    await Promise.allSettled([
      supervisor?.stop?.(),
      worker?.stop?.(),
      sender?.stop?.()
    ]);
    try {
      await listeners?.close?.();
    } catch (error) {
      logger?.error?.('shutdown: closing listeners failed', { error: error?.message ?? String(error) });
    }
    try {
      db?.close?.();
    } catch (error) {
      logger?.error?.('shutdown: closing the database failed', { error: error?.message ?? String(error) });
    }
  })();

  await Promise.race([work, timeout]);
  clearTimer(timerHandle);

  if (timedOut) {
    logger?.error?.('shutdown timed out; forcing exit', { timeoutMs });
    exit(1);
    return;
  }
  exit(0);
}
