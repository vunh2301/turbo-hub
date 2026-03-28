import { WebSocket } from 'ws'
import { AgentRegistry } from './agents.js'
import { WSClientMessage, WSServerMessage, Agent } from './types.js'

interface WSConnection {
  ws: WebSocket
  agentId?: string
  subscribedChannels: Set<string>
}

export class HubWebSocket {
  private connections = new Set<WSConnection>()
  private agentRegistry: AgentRegistry

  constructor(agentRegistry: AgentRegistry) {
    this.agentRegistry = agentRegistry
  }

  handleConnection(ws: WebSocket): void {
    const conn: WSConnection = {
      ws,
      subscribedChannels: new Set(),
    }
    this.connections.add(conn)

    ws.on('message', (data) => {
      try {
        const msg: WSClientMessage = JSON.parse(data.toString())
        this.handleMessage(conn, msg)
      } catch {
        // ignore malformed
      }
    })

    ws.on('close', () => {
      this.connections.delete(conn)
      if (conn.agentId) {
        this.agentRegistry.markOffline(conn.agentId)
        this.broadcastAll({
          type: 'agent_offline',
          agentId: conn.agentId,
        })
      }
    })
  }

  private handleMessage(conn: WSConnection, msg: WSClientMessage): void {
    switch (msg.type) {
      case 'auth': {
        const agent = this.agentRegistry.getByToken(msg.token)
        if (agent) {
          conn.agentId = agent.id
          this.send(conn, { type: 'auth_ok', agentId: agent.id })
        } else {
          this.send(conn, { type: 'auth_error', message: 'Invalid token' })
        }
        break
      }
      case 'subscribe_channel':
        conn.subscribedChannels.add(msg.channelId)
        break
      case 'unsubscribe_channel':
        conn.subscribedChannels.delete(msg.channelId)
        break
      case 'ping':
        this.send(conn, { type: 'pong' })
        if (conn.agentId) this.agentRegistry.heartbeat(conn.agentId)
        break
    }
  }

  broadcastToChannel(channelId: string, msg: WSServerMessage): void {
    for (const conn of this.connections) {
      if (conn.subscribedChannels.has(channelId) && conn.ws.readyState === WebSocket.OPEN) {
        this.send(conn, msg)
      }
    }
  }

  broadcastAll(msg: WSServerMessage): void {
    for (const conn of this.connections) {
      if (conn.ws.readyState === WebSocket.OPEN) {
        this.send(conn, msg)
      }
    }
  }

  private send(conn: WSConnection, msg: WSServerMessage): void {
    try {
      conn.ws.send(JSON.stringify(msg))
    } catch {
      // connection closed
    }
  }
}
