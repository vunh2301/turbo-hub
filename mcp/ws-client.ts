import WebSocket from 'ws'

export type MessageHandler = (channelId: string, message: any) => void

export class HubWsClient {
  private ws: WebSocket | null = null
  private buffers = new Map<string, any[]>()      // channelId → buffered messages
  private subscribedChannels = new Set<string>()
  private token: string | null = null
  private wsUrl: string
  private pingInterval: ReturnType<typeof setInterval> | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private destroyed = false
  private onMessageHandler: MessageHandler | null = null

  constructor(hubUrl: string) {
    this.wsUrl = hubUrl.replace(/^http/, 'ws') + '/ws'
  }

  // Called after agent registers and gets a token
  connect(token: string): void {
    this.token = token
    this._connect()
  }

  private _connect(): void {
    if (this.destroyed) return

    this.ws = new WebSocket(this.wsUrl)

    this.ws.on('open', () => {
      // Authenticate
      this.ws!.send(JSON.stringify({ type: 'auth', token: this.token }))

      // Re-subscribe to all channels (in case of reconnect)
      for (const chId of this.subscribedChannels) {
        this.ws!.send(JSON.stringify({ type: 'subscribe_channel', channelId: chId }))
      }

      // Keepalive ping every 20s
      this.pingInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ type: 'ping' }))
        }
      }, 20_000)
    })

    this.ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'channel_message') {
          const buf = this.buffers.get(msg.channelId)
          if (buf) buf.push(msg.message)
          // Notify realtime handler (for sampling/auto-respond)
          if (this.onMessageHandler && this.subscribedChannels.has(msg.channelId)) {
            this.onMessageHandler(msg.channelId, msg.message)
          }
        }
      } catch {
        // ignore malformed
      }
    })

    this.ws.on('close', () => {
      if (this.pingInterval) clearInterval(this.pingInterval)
      if (!this.destroyed) {
        // Reconnect after 3s
        this.reconnectTimer = setTimeout(() => this._connect(), 3_000)
      }
    })

    this.ws.on('error', () => {
      // handled by 'close'
    })
  }

  // Subscribe to a channel — future messages will be buffered
  subscribe(channelId: string): void {
    this.subscribedChannels.add(channelId)
    if (!this.buffers.has(channelId)) {
      this.buffers.set(channelId, [])
    }
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'subscribe_channel', channelId }))
    }
  }

  unsubscribe(channelId: string): void {
    this.subscribedChannels.delete(channelId)
    this.buffers.delete(channelId)
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ type: 'unsubscribe_channel', channelId }))
    }
  }

  // Drain the buffer — returns all buffered messages and clears them
  flush(channelId: string): any[] {
    const msgs = this.buffers.get(channelId) ?? []
    this.buffers.set(channelId, [])
    return msgs
  }

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  onMessage(handler: MessageHandler): void {
    this.onMessageHandler = handler
  }

  destroy(): void {
    this.destroyed = true
    if (this.pingInterval) clearInterval(this.pingInterval)
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }
}
