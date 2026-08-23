export interface AppConfig {
  port: number
  sharedSecret: string
  itemsPath: string
  sessionPath: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const sharedSecret = env.SHARED_SECRET
  if (!sharedSecret) {
    throw new Error('SHARED_SECRET environment variable is required')
  }
  return {
    port: Number(env.PORT ?? 3000),
    sharedSecret,
    itemsPath: env.ITEMS_PATH ?? 'items.yml',
    sessionPath: env.SESSION_PATH ?? 'session.json',
  }
}
