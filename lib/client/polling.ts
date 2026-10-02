export function canPoll(visibilityState: DocumentVisibilityState): boolean {
  return visibilityState === "visible";
}

export function createVisibleRefreshStagger(staggerMs = 250, batchWindowMs = 1000) {
  let batchStartedAt = Number.NEGATIVE_INFINITY;
  let scheduled = 0;
  return (now: number) => {
    if (now - batchStartedAt > batchWindowMs) {
      batchStartedAt = now;
      scheduled = 0;
    }
    return scheduled++ * staggerMs;
  };
}

const visibleRefreshDelay = createVisibleRefreshStagger();

export function scheduleVisibleRefresh(callback: () => void): ReturnType<typeof setTimeout> {
  return setTimeout(callback, visibleRefreshDelay(Date.now()));
}