import { v4 as uuid } from 'uuid'
import { HubMessage, SendMessageRequest, Agent, HubConfig } from './types.js'

export class MessageStore {
  private messages = new Map<string, HubMessage[]>()
  private seqCounters = new Map<string, number>()
  private config: HubConfig

  constructor(config: HubConfig) {
    this.config = config
  }

  add(channelId: string, agent: Agent, req: SendMessageRequest): HubMessage {
    if (!this.messages.has(channelId)) {
      this.messages.set(channelId, [])
      this.seqCounters.set(channelId, 0)
    }

    const seq = (this.seqCounters.get(channelId) ?? 0) + 1
    this.seqCounters.set(channelId, seq)

    const mentions = req.mentions ?? this.parseMentions(req.text)

    const message: HubMessage = {
      id: `msg_${uuid().slice(0, 8)}`,
      channelId,
      agentId: agent.id,
      agentName: agent.name,
      agentType: agent.type,
      content: req.text,
      mentions,
      replyTo: req.replyTo,
      timestamp: Date.now(),
      seq,
    }

    const msgs = this.messages.get(channelId)!
    msgs.push(message)

    // Ring buffer: evict oldest
    if (msgs.length > this.config.maxMessagesPerChannel) {
      msgs.splice(0, msgs.length - this.config.maxMessagesPerChannel)
    }

    return message
  }

  get(channelId: string, since?: number, limit = 50): HubMessage[] {
    const msgs = this.messages.get(channelId) ?? []
    let filtered = msgs
    if (since) {
      filtered = msgs.filter((m) => m.timestamp > since)
    }
    return filtered.slice(-limit)
  }

  getRecent(channelId: string, count = 20): HubMessage[] {
    const msgs = this.messages.get(channelId) ?? []
    return msgs.slice(-count)
  }

  private parseMentions(text: string): string[] {
    const regex = /@([a-zA-Z0-9_-]+)/g
    const mentions: string[] = []
    let match
    while ((match = regex.exec(text)) !== null) {
      mentions.push(match[1])
    }
    return mentions
  }
}
