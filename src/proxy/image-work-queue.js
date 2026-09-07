export function createImageWorkQueue() {
  let active = 0;
  const pending = [];
  const drain = () => {
    while (pending.length && active < pending[0].maxConcurrent) {
      pending.shift().start();
    }
  };
  return {
    run(operation, { signal, maxConcurrent = 2, maxQueue = 8 } = {}) {
      return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        let started = false;
        const onAbort = () => {
          const index = pending.indexOf(job);
          if (index >= 0) pending.splice(index, 1);
          reject(signal.reason);
          if (!started) {
            signal.removeEventListener("abort", onAbort);
            drain();
          }
        };
        const job = {
          maxConcurrent,
          start() {
            started = true;
            active += 1;
            Promise.resolve().then(operation).then(resolve, reject).finally(() => {
              signal?.removeEventListener("abort", onAbort);
              active -= 1;
              drain();
            });
          }
        };
        const canStart = active < maxConcurrent && pending.length === 0;
        if (!canStart && pending.length >= maxQueue) {
          reject(Object.assign(new Error("Image optimization queue is full"), { code: "IMAGE_QUEUE_FULL" }));
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });
        if (canStart) job.start();
        else pending.push(job);
      });
    }
  };
}