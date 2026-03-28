import { v4 as uuid } from 'uuid'
import { Agent, RegisterRequest, RegisterResponse, HubConfig } from './types.js'

export class AgentRegistry {
  private agents = new Map<string, Agent>()
  private tokenToAgent = new Map<string, string>() // token → agentId
  private config: HubConfig

  constructor(config: HubConfig) {
    this.config = config
    // Cleanup interval: remove offline agents after 24h
    setInterval(() => this.evictStale(), 60_000)
  }

  register(req: RegisterRequest): RegisterResponse {
    if (this.agents.size >= this.config.maxAgents) {
      throw new Error(`Max agents (${this.config.maxAgents}) reached`)
    }

    const agentId = `agent_${uuid().slice(0, 8)}`
    const token = `tok_${uuid().replace(/-/g, '')}`
    const now = Date.now()

    const agent: Agent = {
      id: agentId,
      name: req.name,
      type: req.type,
      status: 'online',
      capabilities: req.capabilities ?? [],
      registeredAt: now,
      lastHeartbeatAt: now,
      metadata: req.metadata ?? {},
    }

    this.agents.set(agentId, agent)
    this.tokenToAgent.set(token, agentId)

    return {
      agentId,
      token,
      hub: {
        version: '0.1.0',
        wsEndpoint: `ws://${this.config.host}:${this.config.port}/ws`,
      },
    }
  }

  heartbeat(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    agent.lastHeartbeatAt = Date.now()
    agent.status = 'online'
    return true
  }

  getByToken(token: string): Agent | undefined {
    const agentId = this.tokenToAgent.get(token)
    if (!agentId) return undefined
    return this.agents.get(agentId)
  }

  get(agentId: string): Agent | undefined {
    return this.agents.get(agentId)
  }

  list(): Agent[] {
    return Array.from(this.agents.values())
  }

  remove(agentId: string): boolean {
    const agent = this.agents.get(agentId)
    if (!agent) return false
    // Remove token mapping
    for (const [token, id] of this.tokenToAgent) {
      if (id === agentId) {
        this.tokenToAgent.delete(token)
        break
      }
    }
    this.agents.delete(agentId)
    return true
  }

  markOffline(agentId: string): void {
    const agent = this.agents.get(agentId)
    if (agent) agent.status = 'offline'
  }

  private evictStale(): void {
    const now = Date.now()
    const staleThreshold = 24 * 60 * 60 * 1000 // 24h
    for (const [id, agent] of this.agents) {
      if (agent.status === 'offline' && now - agent.lastHeartbeatAt > staleThreshold) {
        this.remove(id)
      } else if (now - agent.lastHeartbeatAt > this.config.heartbeatTimeoutMs) {
        agent.status = 'offline'
      }
    }
  }
}
