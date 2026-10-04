import { describe, expect, it } from 'vitest'
import { UserRateLimiter } from './rate-limit.ts'

describe('UserRateLimiter', () => {
  it('allows the maximum per window per key, then reports when to retry', () => {
    let clock = 0
    const limiter = new UserRateLimiter(2, () => clock)
    expect(limiter.hit('a')).toEqual({ ok: true })
    expect(limiter.hit('a')).toEqual({ ok: true })
    clock = 20_000
    expect(limiter.hit('a')).toEqual({ ok: false, retryAfterSeconds: 40 })
    expect(limiter.hit('b')).toEqual({ ok: true })
  })

  it('starts a new window once the previous one ends', () => {
    let clock = 0
    const limiter = new UserRateLimiter(1, () => clock)
    limiter.hit('a')
    expect(limiter.hit('a').ok).toBe(false)
    clock = 60_000
    expect(limiter.hit('a')).toEqual({ ok: true })
  })
})
