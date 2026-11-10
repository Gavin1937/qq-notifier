import { renderMessage } from './format.js';

const UNREACHABLE_DELAY_MS = 5000;

/**
 * Three classes:
 *   unreachable - the bot is not connected; retrying later is expected to work,
 *                 so the attempt counter is not consumed.
 *   rejected    - a definite platform rejection (4xx); resend as plain text once.
 *   uncertain   - timeout / 5xx / network error; the message may or may not have landed.
 */
export function classifySendError(error) {
  const status = error?.httpStatus;
  if (status === 503) return 'unreachable';
  if (typeof status === 'number' && status >= 400 && status < 500) return 'rejected';
  return 'uncertain';
}

export function isDefiniteRejection(error) {
  const status = error?.httpStatus;
  return typeof status === 'number' && status >= 400 && status < 500;
}

const RUNTIME_KEYS = ['failure_streak', 'cooldown_until', 'halted', 'halted_reason'];

export function createWorker({ db, sender, queue, logger, now = () => Date.now(), sleep } = {}) {
  let running = false;
  let wakeResolve = null;
  let loopPromise = null;

  function readRuntime() {
    return {
      streak: Number(db.getRuntime('failure_streak') ?? 0),
      cooldownUntil: Number(db.getRuntime('cooldown_until') ?? 0),
      halted: db.getRuntime('halted') === '1'
    };
  }

  function resetFailure() {
    for (const key of ['failure_streak', 'cooldown_until', 'last_error']) db.deleteRuntime(key);
  }

  function applyFailure() {
    const streak = Number(db.getRuntime('failure_streak') ?? 0) + 1;
    db.setRuntime('failure_streak', streak);
    if (streak >= 2) {
      const cooldown = Math.min(queue.cooldown_ms * (2 ** (streak - 2)), queue.cooldown_max_ms);
      db.setRuntime('cooldown_until', now() + cooldown);
      logger?.warn?.('delivery failures in a row, cooling down', { streak, cooldown_ms: cooldown });
    }
    if (streak >= queue.halt_after_abandons) {
      db.setRuntime('halted', '1');
      db.setRuntime('halted_reason', `failure_streak=${streak}`);
      logger?.error?.('worker halted after repeated delivery failures; run `qqn resume` to continue', { streak });
    }
  }

  function messageError(error) {
    return error?.message ? String(error.message) : String(error);
  }

  /**
   * Process at most one queued message. Returns the action taken, which the
   * scheduler uses to decide how long to sleep and which tests assert on.
   */
  async function tick() {
    const state = readRuntime();
    if (state.halted) return 'halted';
    if (state.cooldownUntil > now()) return 'cooldown';

    const message = db.nextDue(now());
    if (!message) return 'idle';
    if (!sender.isReady()) return 'not-ready';

    const rendered = renderMessage({
      body: message.body,
      key: message.user_key,
      receivedAt: message.received_at
    });

    try {
      await sender.send(rendered);
    } catch (error) {
      const kind = classifySendError(error);
      const lastError = messageError(error);
      db.setRuntime('last_error', lastError);
      if (kind === 'unreachable') {
        db.updateRetry(message.id, message.attempts, now() + UNREACHABLE_DELAY_MS, lastError);
        return 'unreachable';
      }
      const attempts = message.attempts + 1;
      if (attempts < queue.max_attempts) {
        const delay = queue.backoff_ms[Math.min(attempts - 1, queue.backoff_ms.length - 1)];
        db.updateRetry(message.id, attempts, now() + delay, lastError);
        return 'retry';
      }
      db.complete(message.id, { status: 'abandoned', finishedAt: now(), attempts, lastError });
      applyFailure();
      logger?.warn?.('message abandoned after retries', { id: message.id, attempts, error: lastError });
      return 'abandoned';
    }

    db.complete(message.id, { status: 'sent', finishedAt: now(), attempts: message.attempts + 1 });
    resetFailure();
    logger?.info?.('message sent', { id: message.id, attempts: message.attempts + 1 });
    return 'sent';
  }

  function delayFor(action) {
    const state = readRuntime();
    if (action === 'halted') return null;
    if (action === 'cooldown') return Math.max(1000, state.cooldownUntil - now());
    if (action === 'retry' || action === 'unreachable' || action === 'idle' || action === 'not-ready') return 1000;
    return Math.max(1000 / queue.send_rate_per_second, 100);
  }

  function wait(ms) {
    return new Promise((resolve) => {
      const finish = () => {
        if (timer) clearTimeout(timer);
        wakeResolve = null;
        resolve();
      };
      const timer = ms === null ? null : setTimeout(finish, ms);
      wakeResolve = finish;
    });
  }

  function wake() {
    wakeResolve?.();
  }

  async function start() {
    if (running) return loopPromise;
    running = true;
    loopPromise = (async () => {
      while (running) {
        let action = 'idle';
        try {
          action = await tick();
        } catch (error) {
          logger?.error?.('worker iteration failed', { error: messageError(error) });
        }
        if (!running) break;
        await wait(delayFor(action));
      }
    })();
    return loopPromise;
  }

  async function stop() {
    running = false;
    wake();
    await loopPromise;
  }

  function resume() {
    for (const key of RUNTIME_KEYS) db.deleteRuntime(key);
    logger?.info?.('worker resumed');
    wake();
  }

  function state() {
    return readRuntime();
  }

  return { tick, start, stop, wake, resume, state, delayFor };
}
