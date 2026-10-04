import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import { registerPrivacy } from './privacy.ts'

describe('privacy', () => {
  it('serves the policy without authentication', async () => {
    const app = Fastify()
    await registerPrivacy(app)
    const response = await app.inject({ method: 'GET', url: '/privacy' })
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/html')
    expect(response.body).toContain('Privacy policy')
    await app.close()
  })
})
