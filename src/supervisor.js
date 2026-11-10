const DEFAULT_MIN_DELAY_MS = 1000;
const DEFAULT_MAX_DELAY_MS = 30000;
const DEFAULT_CHECK_INTERVAL_MS = 2000;

/**
 * Keeps the QQ bot connected: retries a failed initial connection with
 * exponential backoff, and re-connects if the adapter reports `not ready`
 * after a disconnect. The delivery worker only sends while the bot is ready,
 * so a down bot never consumes delivery attempts.
 */
export function createSupervisor({
  sender,
  logger,
  minDelayMs = DEFAULT_MIN_DELAY_MS,
  maxDelayMs = DEFAULT_MAX_DELAY_MS,
  checkIntervalMs = DEFAULT_CHECK_INTERVAL_MS
} = {}) {
  let running = false;
  let loop = null;
  let delay = minDelayMs;
  let wake = null;

  function sleep(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        clearTimeout(timer);
        if (wake === finish) wake = null;
        resolve();
      };
      const timer = setTimeout(finish, ms);
      wake = finish;
    });
  }

  /** One supervision step; separated from the loop so it can be tested without timers. */
  async function tick() {
    if (sender.isReady()) {
      delay = minDelayMs;
      return { connected: true, started: false, waitMs: checkIntervalMs };
    }
    try {
      await sender.start();
      delay = minDelayMs;
      return { connected: true, started: true, waitMs: checkIntervalMs };
    } catch (error) {
      const waitMs = delay;
      delay = Math.min(delay * 2, maxDelayMs);
      return { connected: false, started: false, waitMs, error };
    }
  }

  async function start() {
    if (running) return loop;
    running = true;
    loop = (async () => {
      while (running) {
        const result = await tick();
        if (result.error) {
          logger?.warn?.('qq bot connect failed; retrying', {
            error: result.error?.message ?? String(result.error),
            retry_in_ms: result.waitMs
          });
        }
        if (!running) break;
        await sleep(result.waitMs);
      }
    })();
    return loop;
  }

  async function stop() {
    running = false;
    wake?.();
    await loop;
  }

  return { start, stop, tick };
}
