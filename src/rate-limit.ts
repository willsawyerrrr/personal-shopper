/** A fixed-window request counter keyed by user, complementing the per-IP limits. */
export class UserRateLimiter {
  private readonly windows = new Map<string, { count: number; resetsAt: number }>()

  constructor(
    private readonly max: number,
    private readonly now: () => number = Date.now,
    private readonly windowMs = 60_000,
  ) {}

  /** Counts a request by `key`; returns the seconds to wait if it is over the limit. */
  hit(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
    const now = this.now()
    for (const [other, window] of this.windows) {
      if (window.resetsAt <= now) {
        this.windows.delete(other)
      }
    }
    const window = this.windows.get(key) ?? { count: 0, resetsAt: now + this.windowMs }
    window.count += 1
    this.windows.set(key, window)
    return window.count > this.max
      ? { ok: false, retryAfterSeconds: Math.ceil((window.resetsAt - now) / 1000) }
      : { ok: true }
  }
}
