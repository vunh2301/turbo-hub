import { FastifyInstance } from 'fastify'
import { AgentRegistry } from './agents.js'
import { ChannelManager } from './channels.js'
import { MessageStore } from './messages.js'
import { HubWebSocket } from './ws.js'
import { HubConfig, RegisterRequest, CreateChannelRequest, SendMessageRequest, Agent } from './types.js'

export function registerRoutes(
  app: FastifyInstance,
  agents: AgentRegistry,
  channels: ChannelManager,
  messages: MessageStore,
  hubWs: HubWebSocket,
  config: HubConfig
) {
  // ─── Auth helper ───────────────────────────────────

  function getAgent(req: any): Agent | null {
    const auth = req.headers.authorization
    if (!auth?.startsWith('Bearer ')) return null
    const token = auth.slice(7)
    return agents.getByToken(token) ?? null
  }

  function requireAgent(req: any, reply: any): Agent | null {
    const agent = getAgent(req)
    if (!agent) {
      reply.code(401).send({ error: 'unauthorized', message: 'Invalid or missing token' })
      return null
    }
    agents.heartbeat(agent.id)
    return agent
  }

  // ─── System ────────────────────────────────────────

  app.get('/api/status', async () => ({
    status: 'ok',
    version: '0.1.0',
    agents: agents.list().length,
    channels: channels.list('active').length,
    uptime: process.uptime(),
  }))

  // ─── Agents ────────────────────────────────────────

  app.post('/api/agents/register', async (req, reply) => {
    // Validate hub token if configured (skip check for default dev token)
    if (config.token !== 'dev-shared-secret') {
      const hubToken = (req.headers as any)['x-hub-token']
      if (hubToken !== config.token) {
        return reply.code(401).send({ error: 'unauthorized', message: 'Invalid or missing hub token' })
      }
    }

    const body = req.body as RegisterRequest

    if (!body.name) {
      return reply.code(400).send({ error: 'validation_failed', message: 'name required' })
    }

    try {
      const result = agents.register(body)
      hubWs.broadcastAll({
        type: 'agent_online',
        agent: { id: result.agentId, name: body.name, type: body.type, status: 'online' },
      })
      return result
    } catch (e: any) {
      return reply.code(409).send({ error: 'limit_reached', message: e.message })
    }
  })

  app.post('/api/agents/:agentId/heartbeat', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    if (!agents.heartbeat(agentId)) {
      return reply.code(404).send({ error: 'not_found' })
    }
    return { ok: true }
  })

  app.get('/api/agents', async () => ({
    agents: agents.list().map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      status: a.status,
      capabilities: a.capabilities,
      registeredAt: a.registeredAt,
    })),
  }))

  app.delete('/api/agents/:agentId', async (req, reply) => {
    const { agentId } = req.params as { agentId: string }
    const agent = agents.get(agentId)
    if (!agent) {
      return reply.code(404).send({ error: 'not_found' })
    }
    // Remove from all channels
    for (const ch of channels.list()) {
      channels.leave(ch.id, agentId)
    }
    agents.remove(agentId)
    hubWs.broadcastAll({ type: 'agent_offline', agentId })
    return { ok: true }
  })

  // ─── Channels ──────────────────────────────────────

  app.post('/api/channels', async (req, reply) => {
    const agent = requireAgent(req, reply)
    if (!agent) return

    const body = req.body as CreateChannelRequest
    if (!body.name) {
      return reply.code(400).send({ error: 'validation_failed', message: 'name required' })
    }

    try {
      const channel = channels.create(body, agent)
      return { channel }
    } catch (e: any) {
      return reply.code(409).send({ error: 'limit_reached', message: e.message })
    }
  })

  app.get('/api/channels', async () => ({
    channels: channels.list().map((ch) => ({
      id: ch.id,
      name: ch.name,
      status: ch.status,
      memberCount: ch.members.length,
      createdAt: ch.createdAt,
    })),
  }))

  app.get('/api/channels/:channelId', async (req, reply) => {
    const { channelId } = req.params as { channelId: string }
    const channel = channels.get(channelId)
    if (!channel) return reply.code(404).send({ error: 'not_found' })
    return { channel }
  })

  app.post('/api/channels/:channelId/join', async (req, reply) => {
    const agent = requireAgent(req, reply)
    if (!agent) return

    const { channelId } = req.params as { channelId: string }
    const member = channels.join(channelId, agent)
    if (!member) {
      return reply.code(404).send({ error: 'not_found', message: 'Channel not found or archived' })
    }

    hubWs.broadcastToChannel(channelId, {
      type: 'member_joined',
      channelId,
      member,
    })

    // System message: agent joined
    const sysMsg = messages.addSystem(channelId, `${agent.name} joined the channel`)
    hubWs.broadcastToChannel(channelId, {
      type: 'channel_message',
      channelId,
      message: sysMsg,
    })

    // Return recent messages for context
    const recent = messages.getRecent(channelId, 20)
    return { member, recentMessages: recent }
  })

  app.post('/api/channels/:channelId/leave', async (req, reply) => {
    const agent = requireAgent(req, reply)
    if (!agent) return

    const { channelId } = req.params as { channelId: string }
    if (!channels.leave(channelId, agent.id)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    hubWs.broadcastToChannel(channelId, {
      type: 'member_left',
      channelId,
      agentId: agent.id,
    })

    // System message: agent left
    const sysMsg = messages.addSystem(channelId, `${agent.name} left the channel`)
    hubWs.broadcastToChannel(channelId, {
      type: 'channel_message',
      channelId,
      message: sysMsg,
    })

    return { ok: true }
  })

  app.delete('/api/channels/:channelId', async (req, reply) => {
    const agent = requireAgent(req, reply)
    if (!agent) return

    const { channelId } = req.params as { channelId: string }
    if (!channels.archive(channelId)) {
      return reply.code(404).send({ error: 'not_found' })
    }

    hubWs.broadcastToChannel(channelId, {
      type: 'channel_archived',
      channelId,
    })

    return { ok: true }
  })

  // ─── Messages ──────────────────────────────────────

  app.post('/api/channels/:channelId/messages', async (req, reply) => {
    const agent = requireAgent(req, reply)
    if (!agent) return

    const { channelId } = req.params as { channelId: string }

    if (!channels.isMember(channelId, agent.id)) {
      return reply.code(403).send({ error: 'not_member', message: 'Join channel first' })
    }

    const body = req.body as SendMessageRequest
    if (!body.text) {
      return reply.code(400).send({ error: 'validation_failed', message: 'text required' })
    }
    if (body.text.length > 10_240) {
      return reply.code(400).send({ error: 'validation_failed', message: 'text exceeds 10KB limit' })
    }

    const message = messages.add(channelId, agent, body)

    hubWs.broadcastToChannel(channelId, {
      type: 'channel_message',
      channelId,
      message,
    })

    return { message }
  })

  app.get('/api/channels/:channelId/messages', async (req, reply) => {
    const { channelId } = req.params as { channelId: string }
    const { since, limit } = req.query as { since?: string; limit?: string }

    const msgs = messages.get(
      channelId,
      since ? parseInt(since) : undefined,
      limit ? parseInt(limit) : 50
    )

    return { messages: msgs }
  })
}
