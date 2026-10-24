import { createApp } from './app'

const port = Number(process.env.API_PORT ?? 3001)
const host = process.env.API_HOST ?? '127.0.0.1'

if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('API_PORT must be an integer from 1 to 65535.')
}

createApp().listen(port, host, () => {
  console.log(`AgentOps local API listening at http://${host}:${port}`)
})
