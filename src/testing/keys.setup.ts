import { exportJWK, generateKeyPair, type JWK } from 'jose'
import type { TestProject } from 'vitest/node'

export interface TestKeyPair {
  publicJwk: JWK
  privateJwk: JWK
}

declare module 'vitest' {
  export interface ProvidedContext {
    googleKeyPairs: TestKeyPair[]
  }
}

/** RSA key generation is slow and CPU-bound, so it runs once here instead of inside a test hook. */
export default async function setup(project: TestProject): Promise<void> {
  const keyPairs = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
      return { publicJwk: await exportJWK(publicKey), privateJwk: await exportJWK(privateKey) }
    }),
  )
  project.provide('googleKeyPairs', keyPairs)
}
