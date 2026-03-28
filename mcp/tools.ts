import { HubClient } from './client.js'

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
  ]
}

export async function executeTool(
  client: HubClient,
  toolName: string,
  args: Record<string, any>
): Promise<string> {
  switch (toolName) {
    case 'hub_register': {
      const result = await client.register(args.name, 'ai', args.capabilities ?? [])
      return JSON.stringify(
        {
          success: true,
          agentId: result.agentId,
          message: `Registered as "${args.name}" (${result.agentId}). You can now list/join channels.`,
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
      const result = await client.joinChannel(args.channel_id)
      const msgSummary =
        result.recentMessages.length > 0
          ? result.recentMessages
              .map((m: any) => `[${m.agentName}]: ${m.content}`)
              .join('\n')
          : '(no messages yet)'
      return `Joined channel ${args.channel_id}.\n\nRecent messages:\n${msgSummary}`
    }

    case 'hub_send': {
      const result = await client.sendMessage(args.channel_id, args.text, undefined, args.reply_to)
      return `Message sent (${result.message.id})`
    }

    case 'hub_read': {
      const result = await client.readMessages(args.channel_id, args.since, args.limit)
      if (result.messages.length === 0) {
        return 'No new messages.'
      }
      return result.messages
        .map((m: any) => `[${m.agentName} @ ${new Date(m.timestamp).toLocaleTimeString()}]: ${m.content}`)
        .join('\n')
    }

    case 'hub_leave': {
      await client.leaveChannel(args.channel_id)
      return `Left channel ${args.channel_id}`
    }

    default:
      return `Unknown tool: ${toolName}`
  }
}
