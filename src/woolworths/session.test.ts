import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  SESSION_EXPIRED_MESSAGE,
  SessionRejectedError,
  SessionStore,
  type SessionStorage,
  type StoredSession,
} from './session.ts'

describe('SessionStore', () => {
  let stored: StoredSession | undefined
  let storage: SessionStorage
  let store: SessionStore

  beforeEach(() => {
    stored = undefined
    storage = {
      load: async () => stored,
      save: async (session) => {
        stored = session
      },
    }
    store = new SessionStore(storage)
  })

  it('round-trips a saved session', async () => {
    const session: StoredSession = {
      cookies: [{ name: 'wow-auth-token', value: 'abc' }],
      capturedAt: new Date().toISOString(),
    }
    await store.save(session)
    await expect(store.load()).resolves.toEqual(session)
  })

  it('has no session until one is saved', async () => {
    await expect(store.find()).resolves.toBeUndefined()
    await expect(store.load()).rejects.toThrow(SessionRejectedError)
  })

  it('treats a freshly captured session as not expired', () => {
    const session: StoredSession = { cookies: [], capturedAt: new Date().toISOString() }
    expect(store.isExpired(session)).toBe(false)
  })

  it('treats an hour-old session as expired', () => {
    const capturedAt = new Date(Date.now() - 60 * 60 * 1000).toISOString()
    expect(store.isExpired({ cookies: [], capturedAt })).toBe(true)
  })

  it('joins cookies into a Cookie header', () => {
    const session: StoredSession = {
      cookies: [
        { name: 'a', value: '1' },
        { name: 'b', value: '2' },
      ],
      capturedAt: new Date().toISOString(),
    }
    expect(store.toCookieHeader(session)).toBe('a=1; b=2')
  })

  describe('refresh', () => {
    const originalFetch = global.fetch
    const stale: StoredSession = {
      cookies: [
        { name: 'wow-auth-token', value: 'old' },
        { name: 'w-aref', value: 'old-aref' },
        { name: '_abck', value: 'akamai' },
      ],
      capturedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    }

    function heartbeat(body: unknown, setCookies: string[], status = 200): Response {
      const headers = new Headers()
      for (const cookie of setCookies) {
        headers.append('Set-Cookie', cookie)
      }
      return new Response(JSON.stringify(body), { status, headers })
    }

    afterEach(() => {
      global.fetch = originalFetch
    })

    it('sends the cookie jar and persists re-issued cookies, including the rotated w-aref', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(
          heartbeat({ refreshed: true }, [
            'wow-auth-token=new; Path=/; Max-Age=3600; HttpOnly',
            'w-aref=new-aref; Path=/auth; Max-Age=2592000; HttpOnly',
            'w-loggedin=true; Path=/; Max-Age=3600',
          ]),
        )
      global.fetch = fetchMock

      const refreshed = await store.refresh(stale)

      expect(fetchMock).toHaveBeenCalledWith(
        'https://www.woolworths.com.au/auth/heartbeat',
        expect.objectContaining({
          headers: expect.objectContaining({
            Cookie: 'wow-auth-token=old; w-aref=old-aref; _abck=akamai',
          }),
        }),
      )
      expect(refreshed.cookies).toEqual([
        { name: 'wow-auth-token', value: 'new' },
        { name: 'w-aref', value: 'new-aref' },
        { name: '_abck', value: 'akamai' },
        { name: 'w-loggedin', value: 'true' },
      ])
      expect(store.isExpired(refreshed)).toBe(false)
      await expect(store.load()).resolves.toEqual(refreshed)
    })

    it('drops cookies the server clears', async () => {
      global.fetch = vi
        .fn()
        .mockResolvedValue(
          heartbeat({ refreshed: true }, ['w-aref=new-aref; Path=/auth', '_abck=; Max-Age=0']),
        )
      const refreshed = await store.refresh(stale)
      expect(refreshed.cookies.map((cookie) => cookie.name)).not.toContain('_abck')
    })

    it.each([
      ['a non-200 response', () => heartbeat({}, [], 401)],
      ['refreshed: false', () => heartbeat({ refreshed: false }, ['w-aref=x; Path=/auth'])],
      ['no w-aref re-issued', () => heartbeat({ refreshed: true }, ['wow-auth-token=new'])],
      ['an unparseable body', () => new Response('<html>', { status: 200 })],
    ])('treats %s as an expired session and leaves the stored jar alone', async (_, respond) => {
      await store.save(stale)
      global.fetch = vi.fn().mockResolvedValue(respond())
      await expect(store.refresh(stale)).rejects.toThrow(SESSION_EXPIRED_MESSAGE)
      await expect(store.load()).resolves.toEqual(stale)
    })

    it('shares one request between concurrent refreshes', async () => {
      const fetchMock = vi
        .fn()
        .mockImplementation(async () => heartbeat({ refreshed: true }, ['w-aref=n; Path=/auth']))
      global.fetch = fetchMock
      await Promise.all([store.refresh(stale), store.refresh(stale)])
      expect(fetchMock).toHaveBeenCalledTimes(1)
    })

    describe('with a passkey login', () => {
      const loggedIn: StoredSession = {
        cookies: [{ name: 'w-aref', value: 'login-aref' }],
        capturedAt: new Date().toISOString(),
      }

      it('logs in and persists the session when the heartbeat is rejected', async () => {
        const login = vi.fn().mockResolvedValue(loggedIn)
        const withLogin = new SessionStore(storage, login)
        global.fetch = vi.fn().mockResolvedValue(heartbeat({}, [], 401))

        await expect(withLogin.refresh(stale)).resolves.toEqual(loggedIn)
        expect(login).toHaveBeenCalledTimes(1)
        await expect(withLogin.load()).resolves.toEqual(loggedIn)
      })

      it('reports the session as expired when the login finds no passkey', async () => {
        const withLogin = new SessionStore(storage, async () => undefined)
        global.fetch = vi.fn().mockResolvedValue(heartbeat({}, [], 401))
        await expect(withLogin.refresh(stale)).rejects.toThrow(SESSION_EXPIRED_MESSAGE)
      })

      it('does not log in when the heartbeat succeeds', async () => {
        const login = vi.fn()
        const withLogin = new SessionStore(storage, login)
        global.fetch = vi
          .fn()
          .mockResolvedValue(heartbeat({ refreshed: true }, ['w-aref=n; Path=/auth']))
        await withLogin.refresh(stale)
        expect(login).not.toHaveBeenCalled()
      })

      it('does not log in on a network failure', async () => {
        const login = vi.fn()
        const withLogin = new SessionStore(storage, login)
        global.fetch = vi.fn().mockRejectedValue(new Error('offline'))
        await expect(withLogin.refresh(stale)).rejects.toThrow('offline')
        expect(login).not.toHaveBeenCalled()
      })

      it('shares one login between concurrent refreshes', async () => {
        const login = vi.fn().mockResolvedValue(loggedIn)
        const withLogin = new SessionStore(storage, login)
        global.fetch = vi.fn().mockImplementation(async () => heartbeat({}, [], 401))
        await Promise.all([withLogin.refresh(stale), withLogin.refresh(stale)])
        expect(login).toHaveBeenCalledTimes(1)
      })

      it('surfaces a failed login and allows a later retry', async () => {
        const login = vi
          .fn()
          .mockRejectedValueOnce(new Error('passkey rejected'))
          .mockResolvedValueOnce(loggedIn)
        const withLogin = new SessionStore(storage, login)
        global.fetch = vi.fn().mockImplementation(async () => heartbeat({}, [], 401))
        await expect(withLogin.refresh(stale)).rejects.toThrow('passkey rejected')
        await expect(withLogin.refresh(stale)).resolves.toEqual(loggedIn)
      })
    })
  })
})
