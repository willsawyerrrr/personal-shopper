import { buildApp } from './app.ts'
import { loadConfig } from './config.ts'
import { WoolworthsClient } from './woolworths/client.ts'
import { SessionStore } from './woolworths/session.ts'

const config = loadConfig()
const sessions = new SessionStore(config.sessionPath)
const woolworths = new WoolworthsClient(sessions)
const app = buildApp(config, woolworths)

app.listen({ port: config.port, host: '0.0.0.0' })
