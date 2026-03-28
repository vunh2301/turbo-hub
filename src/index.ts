import Fastify from 'fastify'
import fastifyWebsocket from '@fastify/websocket'
import fastifyStatic from '@fastify/static'
import fastifyCors from '@fastify/cors'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'

import { AgentRegistry } from './agents.js'
import { ChannelManager } from './channels.js'
import { MessageStore } from './messages.js'
import { HubWebSocket } from './ws.js'
import { registerRoutes } from './routes.js'
import { DEFAULT_CONFIG } from './types.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

async function main() {
  const config = { ...DEFAULT_CONFIG }

  // Override from env
  if (process.env.HUB_PORT) config.port = parseInt(process.env.HUB_PORT)
  if (process.env.HUB_HOST) config.host = process.env.HUB_HOST
  if (process.env.HUB_TOKEN) config.token = process.env.HUB_TOKEN

  // ─── Core services ──────────────────────────────

  const agents = new AgentRegistry(config)
  const channels = new ChannelManager(config)
  const messages = new MessageStore(config)

  // ─── Fastify ────────────────────────────────────

  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } }
        : undefined,
    },
  })

  await app.register(fastifyCors, { origin: true })
  await app.register(fastifyWebsocket)

  // Serve web UI
  await app.register(fastifyStatic, {
    root: resolve(__dirname, '../web'),
    prefix: '/',
  })

  // ─── WebSocket ──────────────────────────────────

  const hubWs = new HubWebSocket(agents)

  app.get('/ws', { websocket: true }, (socket) => {
    hubWs.handleConnection(socket)
  })

  // ─── REST routes ────────────────────────────────

  registerRoutes(app, agents, channels, messages, hubWs, config)

  // ─── Start ──────────────────────────────────────

  await app.listen({ port: config.port, host: config.host })

  console.log()
  console.log('  ╔══════════════════════════════════════════╗')
  console.log('  ║                                          ║')
  console.log('  ║   🧠  T U R B O   H U B                 ║')
  console.log('  ║   AI Agent Collaboration Platform        ║')
  console.log('  ║                                          ║')
  console.log(`  ║   HTTP  → http://${config.host}:${config.port}      ║`)
  console.log(`  ║   WS    → ws://${config.host}:${config.port}/ws     ║`)
  console.log(`  ║   UI    → http://${config.host}:${config.port}      ║`)
  console.log('  ║                                          ║')
  console.log('  ╚══════════════════════════════════════════╝')
  console.log()
}

main().catch((err) => {
  console.error('Failed to start Turbo Hub:', err)
  process.exit(1)
})
