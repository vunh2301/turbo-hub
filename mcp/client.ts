const DEFAULT_HUB_URL = 'http://127.0.0.1:2400'

export class HubClient {
  private baseUrl: string
  private agentToken: string | null = null
  public agentId: string | null = null

  constructor(hubUrl?: string) {
    this.baseUrl = hubUrl || process.env.HUB_URL || DEFAULT_HUB_URL
  }

  async register(name: string, type: 'human' | 'ai' = 'ai', capabilities: string[] = []): Promise<{
    agentId: string
    token: string
  }> {
    const res = await this.fetch('/api/agents/register', {
      method: 'POST',
      body: { name, type, capabilities },
    })
    this.agentToken = res.token
    this.agentId = res.agentId
    return res
  }

  async listChannels(): Promise<any> {
    return this.fetch('/api/channels')
  }

  async createChannel(name: string): Promise<any> {
    return this.fetch('/api/channels', {
      method: 'POST',
      body: { name },
    })
  }

  async joinChannel(channelId: string): Promise<any> {
    return this.fetch(`/api/channels/${channelId}/join`, { method: 'POST' })
  }

  async leaveChannel(channelId: string): Promise<any> {
    return this.fetch(`/api/channels/${channelId}/leave`, { method: 'POST' })
  }

  async sendMessage(channelId: string, text: string, mentions?: string[], replyTo?: string): Promise<any> {
    return this.fetch(`/api/channels/${channelId}/messages`, {
      method: 'POST',
      body: { text, mentions, replyTo },
    })
  }

  async readMessages(channelId: string, since?: number, limit?: number): Promise<any> {
    const params = new URLSearchParams()
    if (since) params.set('since', String(since))
    if (limit) params.set('limit', String(limit))
    const qs = params.toString()
    return this.fetch(`/api/channels/${channelId}/messages${qs ? `?${qs}` : ''}`)
  }

  async getChannel(channelId: string): Promise<any> {
    return this.fetch(`/api/channels/${channelId}`)
  }

  async heartbeat(): Promise<void> {
    if (this.agentId) {
      await this.fetch(`/api/agents/${this.agentId}/heartbeat`, { method: 'POST' })
    }
  }

  private async fetch(path: string, opts?: { method?: string; body?: any }): Promise<any> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.agentToken) {
      headers['Authorization'] = `Bearer ${this.agentToken}`
    }

    const res = await globalThis.fetch(`${this.baseUrl}${path}`, {
      method: opts?.method || 'GET',
      headers,
      body: opts?.body ? JSON.stringify(opts.body) : undefined,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'unknown' }))
      throw new Error(`Hub API error ${res.status}: ${err.error || err.message || 'unknown'}`)
    }

    return res.json()
  }
}
