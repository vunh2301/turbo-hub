// ─── Agent ─────────────────────────────────────────────

export interface Agent {
  id: string
  name: string
  type: 'human' | 'ai'
  status: 'online' | 'offline'
  capabilities: string[]
  registeredAt: number
  lastHeartbeatAt: number
  metadata: Record<string, unknown>
}

export interface RegisterRequest {
  name: string
  type: 'human' | 'ai'
  capabilities?: string[]
  metadata?: Record<string, unknown>
}

export interface RegisterResponse {
  agentId: string
  token: string
  hub: { version: string; wsEndpoint: string }
}

// ─── Channel ───────────────────────────────────────────

export interface Channel {
  id: string
  name: string
  status: 'active' | 'archived'
  createdBy: string
  createdAt: number
  members: ChannelMember[]
}

export interface ChannelMember {
  agentId: string
  agentName: string
  agentType: 'human' | 'ai'
  role: 'owner' | 'participant'
  joinedAt: number
}

export interface CreateChannelRequest {
  name: string
}

// ─── Message ───────────────────────────────────────────

export interface HubMessage {
  id: string
  channelId: string
  agentId: string
  agentName: string
  agentType: 'human' | 'ai' | 'system'
  content: string
  mentions: string[]
  replyTo?: string
  timestamp: number
  seq: number
}

export interface SendMessageRequest {
  text: string
  mentions?: string[]
  replyTo?: string
}

// ─── WebSocket ─────────────────────────────────────────

export type WSClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe_channel'; channelId: string }
  | { type: 'unsubscribe_channel'; channelId: string }
  | { type: 'ping' }

export type WSServerMessage =
  | { type: 'auth_ok'; agentId: string }
  | { type: 'auth_error'; message: string }
  | { type: 'channel_message'; channelId: string; message: HubMessage }
  | { type: 'agent_online'; agent: Pick<Agent, 'id' | 'name' | 'type' | 'status'> }
  | { type: 'agent_offline'; agentId: string }
  | { type: 'member_joined'; channelId: string; member: ChannelMember }
  | { type: 'member_left'; channelId: string; agentId: string }
  | { type: 'channel_archived'; channelId: string }
  | { type: 'pong' }

// ─── Config ────────────────────────────────────────────

export interface HubConfig {
  port: number
  host: string
  token: string
  maxAgents: number
  maxChannels: number
  maxMessagesPerChannel: number
  heartbeatTimeoutMs: number
}

export const DEFAULT_CONFIG: HubConfig = {
  port: 2400,
  host: '127.0.0.1',
  token: process.env.HUB_TOKEN || 'dev-shared-secret',
  maxAgents: 50,
  maxChannels: 50,
  maxMessagesPerChannel: 500,
  heartbeatTimeoutMs: 60_000,
}
