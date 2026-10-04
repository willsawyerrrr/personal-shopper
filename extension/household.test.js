import { describe, expect, it, vi } from 'vitest'
import { createInvite, fetchMembers, joinHousehold, leaveHousehold } from './household-api.js'
import { UnauthorizedError } from './passkey-logic.js'

const respond = (status, body) =>
  vi.fn().mockResolvedValue({ status, ok: status < 400, json: async () => body })

describe('household API', () => {
  it('lists members with the bearer token', async () => {
    const members = [{ email: 'a@example.test', you: true }]
    const fetchImpl = respond(200, { members })
    expect(await fetchMembers('https://example.test/', 't', fetchImpl)).toEqual(members)
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://example.test/household',
      expect.objectContaining({
        method: 'GET',
        headers: { Accept: 'application/json', Authorization: 'Bearer t' },
      }),
    )
  })

  it('creates an invite', async () => {
    const fetchImpl = respond(201, { code: 'abc', expiresAt: 1 })
    expect(await createInvite('https://example.test', 't', fetchImpl)).toEqual({
      code: 'abc',
      expiresAt: 1,
    })
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/household/invites')
    expect(fetchImpl.mock.calls[0][1].method).toBe('POST')
  })

  it('joins with a trimmed code', async () => {
    const fetchImpl = respond(204)
    await joinHousehold('https://example.test', 't', ' abc ', fetchImpl)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe('https://example.test/household/join')
    expect(JSON.parse(init.body)).toEqual({ code: 'abc' })
  })

  it('leaves', async () => {
    const fetchImpl = respond(204)
    await leaveHousehold('https://example.test', 't', fetchImpl)
    expect(fetchImpl.mock.calls[0][0]).toBe('https://example.test/household/leave')
  })

  it("surfaces the server's message and unauthorized responses", async () => {
    await expect(
      joinHousehold('https://example.test', 't', 'x', respond(400, { error: 'Invalid code.' })),
    ).rejects.toThrow('Invalid code.')
    await expect(leaveHousehold('https://example.test', 't', respond(500))).rejects.toThrow(
      'Server error (500)',
    )
    await expect(fetchMembers('https://example.test', 't', respond(401))).rejects.toBeInstanceOf(
      UnauthorizedError,
    )
  })
})
