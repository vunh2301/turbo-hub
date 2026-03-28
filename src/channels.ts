import { v4 as uuid } from 'uuid'
import { Channel, ChannelMember, CreateChannelRequest, Agent, HubConfig } from './types.js'

export class ChannelManager {
  private channels = new Map<string, Channel>()
  private config: HubConfig

  constructor(config: HubConfig) {
    this.config = config
  }

  create(req: CreateChannelRequest, creator: Agent): Channel {
    if (this.activeCount() >= this.config.maxChannels) {
      throw new Error(`Max channels (${this.config.maxChannels}) reached`)
    }

    const channel: Channel = {
      id: `ch_${uuid().slice(0, 8)}`,
      name: req.name,
      status: 'active',
      createdBy: creator.id,
      createdAt: Date.now(),
      members: [
        {
          agentId: creator.id,
          agentName: creator.name,
          agentType: creator.type,
          role: 'owner',
          joinedAt: Date.now(),
        },
      ],
    }

    this.channels.set(channel.id, channel)
    return channel
  }

  get(channelId: string): Channel | undefined {
    return this.channels.get(channelId)
  }

  list(status?: 'active' | 'archived'): Channel[] {
    const all = Array.from(this.channels.values())
    if (status) return all.filter((ch) => ch.status === status)
    return all
  }

  join(channelId: string, agent: Agent): ChannelMember | null {
    const channel = this.channels.get(channelId)
    if (!channel || channel.status !== 'active') return null

    // Already a member?
    const existing = channel.members.find((m) => m.agentId === agent.id)
    if (existing) return existing

    const member: ChannelMember = {
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      role: 'participant',
      joinedAt: Date.now(),
    }

    channel.members.push(member)
    return member
  }

  leave(channelId: string, agentId: string): boolean {
    const channel = this.channels.get(channelId)
    if (!channel) return false

    const idx = channel.members.findIndex((m) => m.agentId === agentId)
    if (idx === -1) return false

    channel.members.splice(idx, 1)
    return true
  }

  archive(channelId: string): boolean {
    const channel = this.channels.get(channelId)
    if (!channel) return false
    channel.status = 'archived'
    return true
  }

  isMember(channelId: string, agentId: string): boolean {
    const channel = this.channels.get(channelId)
    if (!channel) return false
    return channel.members.some((m) => m.agentId === agentId)
  }

  private activeCount(): number {
    return Array.from(this.channels.values()).filter((ch) => ch.status === 'active').length
  }
}
