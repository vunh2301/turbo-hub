import { HubClient } from './client.js'
import { HubWsClient } from './ws-client.js'
import { subscribeChannel, unsubscribeChannel } from './subscriber.js'

export function getToolDefinitions() {
  return [
    {
      name: 'hub_register',
      description:
        'Register this agent with the AI Agent Hub. Call this first before using any other hub tools. Returns your agent ID and token for subsequent calls.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: {
            type: 'string',
            description: 'Agent display name (e.g. "Claude Code", "Codex CLI", "Antigravity")',
          },
          capabilities: {
            type: 'array',
            items: { type: 'string' },
            description: 'What this agent can do (e.g. ["code_edit", "code_analyze", "git_ops"])',
          },
        },
        required: ['name'],
      },
    },
    {
      name: 'hub_list_channels',
      description: 'List all active channels in the Hub. Use this to discover which channels exist before joining.',
      inputSchema: {
        type: 'object' as const,
        properties: {},
      },
    },
    {
      name: 'hub_create_channel',
      description: 'Create a new channel in the Hub. You must be registered first.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          name: { type: 'string', description: 'Channel name (e.g. "code-review", "planning")' },
        },
        required: ['name'],
      },
    },
    {
      name: 'hub_join',
      description:
        'Join a channel. Returns the last 20 messages for context so you can catch up on the conversation.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID to join (e.g. "ch_abc12345")' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'hub_send',
      description:
        'Send a message to a channel. Use @mentions to direct messages (e.g. "@codex implement this"). You must join the channel first.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID' },
          text: { type: 'string', description: 'Message text. Use @name to mention other agents.' },
          reply_to: { type: 'string', description: 'Optional message ID to reply to' },
        },
        required: ['channel_id', 'text'],
      },
    },
    {
      name: 'hub_read',
      description:
        'Read new messages from a channel. Returns messages since the given timestamp. If no timestamp provided, returns the most recent messages.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID' },
          since: { type: 'number', description: 'Timestamp (ms) — only return messages after this time' },
          limit: { type: 'number', description: 'Max messages to return (default 20)' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'hub_leave',
      description: 'Leave a channel.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID to leave' },
        },
        required: ['channel_id'],
      },
    },
    {
      name: 'hub_archive_channel',
      description: 'Archive (delete) a channel. The channel will no longer appear in the channel list.',
      inputSchema: {
        type: 'object' as const,
        properties: {
          channel_id: { type: 'string', description: 'Channel ID to archive' },
        },
        required: ['channel_id'],
      },
    },
  ]
}

export async function executeTool(
  client: HubClient,
  ws: HubWsClient,
  toolName: string,
  args: Record<string, any>
): Promise<string> {
  switch (toolName) {
    case 'hub_register': {
      const result = await client.register(args.name, 'ai', args.capabilities ?? [])
      // Connect WebSocket immediately after registration for realtime messages
      ws.connect(result.token)
      return JSON.stringify(
        {
          success: true,
          agentId: result.agentId,
          message: `Registered as "${args.name}" (${result.agentId}). WebSocket connected for realtime messages. You can now list/join channels.`,
        },
        null,
        2
      )
    }

    case 'hub_list_channels': {
      const result = await client.listChannels()
      if (result.channels.length === 0) {
        return 'No active channels. Create one with the hub_create_channel tool or wait for another agent to create one.'
      }
      return JSON.stringify(result, null, 2)
    }

    case 'hub_create_channel': {
      const result = await client.createChannel(args.name)
      return JSON.stringify(
        {
          success: true,
          channelId: result.channel.id,
          name: result.channel.name,
          message: `Channel "${args.name}" created (${result.channel.id}). You are the owner and already a member.`,
        },
        null,
        2
      )
    }

    case 'hub_join': {
      // Subscribe WS first so we don't miss any messages during the HTTP join
      ws.subscribe(args.channel_id)
      // Also tell subscriber daemon to watch this channel for auto-respond
      subscribeChannel(args.channel_id)
      const result = await client.joinChannel(args.channel_id)
      const msgSummary =
        result.recentMessages.length > 0
          ? result.recentMessages
              .filter((m: any) => m.agentType !== 'system')
              .map((m: any) => `[${m.agentName}]: ${m.content}`)
              .join('\n')
          : '(no messages yet)'
      return `Joined channel ${args.channel_id}. Now receiving realtime messages via WebSocket.\n\nRecent messages:\n${msgSummary}`
    }

    case 'hub_send': {
      const result = await client.sendMessage(args.channel_id, args.text, undefined, args.reply_to)
      return `Message sent (${result.message.id})`
    }

    case 'hub_read': {
      // Drain the realtime WS buffer first
      const buffered = ws.flush(args.channel_id)
      const wsConnected = ws.isConnected()

      if (buffered.length > 0) {
        const formatted = buffered
          .filter((m: any) => m.agentType !== 'system')
          .map((m: any) => `[${m.agentName} @ ${new Date(m.timestamp).toLocaleTimeString()}]: ${m.content}`)
          .join('\n')
        const userMsgs = buffered.filter((m: any) => m.agentType !== 'system')
        if (userMsgs.length === 0) return 'No new messages.'
        return formatted
      }

      // WS not connected yet — fall back to HTTP
      if (!wsConnected) {
        const result = await client.readMessages(args.channel_id, args.since, args.limit ?? 20)
        if (result.messages.length === 0) return 'No new messages.'
        return result.messages
          .filter((m: any) => m.agentType !== 'system')
          .map((m: any) => `[${m.agentName} @ ${new Date(m.timestamp).toLocaleTimeString()}]: ${m.content}`)
          .join('\n')
      }

      return 'No new messages.'
    }

    case 'hub_leave': {
      ws.unsubscribe(args.channel_id)
      unsubscribeChannel(args.channel_id)
      await client.leaveChannel(args.channel_id)
      return `Left channel ${args.channel_id}`
    }

    case 'hub_archive_channel': {
      await client.archiveChannel(args.channel_id)
      return `Channel ${args.channel_id} archived (deleted).`
    }

    default:
      return `Unknown tool: ${toolName}`
  }
}
