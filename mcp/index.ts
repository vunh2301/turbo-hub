#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { HubClient } from './client.js'
import { HubWsClient } from './ws-client.js'
import { getToolDefinitions, executeTool } from './tools.js'

const client = new HubClient(process.env.HUB_URL)
const wsClient = new HubWsClient(process.env.HUB_URL || 'http://127.0.0.1:2400')

const server = new Server(
  {
    name: 'turbo-hub',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
      // Declare sampling support so clients know we may call createMessage
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-ignore — SDK types omit 'sampling' from ServerCapabilities but it is valid per spec
      sampling: {},
    },
  }
)

// ─── In-flight guard: prevent multiple concurrent responses per channel ──────
const responding = new Set<string>()

// ─── Auto-respond via MCP Sampling ───────────────────────────────────────────
wsClient.onMessage(async (channelId, message) => {
  // Only respond to human/ai messages, not our own or system messages
  if (message.agentType === 'system') return
  if (message.agentId === client.agentId) return
  if (responding.has(channelId)) return

  responding.add(channelId)
  try {
    // Build conversation context from recent messages
    const history = await client.readMessages(channelId, undefined, 10)
    const contextMsgs = (history?.messages ?? [])
      .filter((m: any) => m.agentType !== 'system')
      .map((m: any) => ({
        role: m.agentId === client.agentId ? 'assistant' : 'user',
        content: { type: 'text', text: `[${m.agentName}]: ${m.content}` },
      }))

    if (contextMsgs.length === 0) return

    // Request the AI client (Claude Code / Codex) to generate a reply
    const result = await server.createMessage({
      messages: contextMsgs as any,
      systemPrompt:
        'You are an AI agent connected to Turbo Hub, a multi-agent collaboration platform. ' +
        'Respond helpfully and concisely to the conversation. ' +
        'You may see messages from multiple agents prefixed with [AgentName]. ' +
        'Reply naturally as yourself without the prefix.',
      maxTokens: 800,
    })

    const block = result?.content
    const text = block && 'text' in block && typeof (block as any).text === 'string'
      ? (block as any).text.trim()
      : null

    if (text) {
      await client.sendMessage(channelId, text)
    }
  } catch (err: any) {
    console.error('[turbo-hub] sampling error:', err?.message ?? err)
  } finally {
    responding.delete(channelId)
  }
})

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}))

// Execute tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const result = await executeTool(client, wsClient, name, args ?? {})
    return {
      content: [{ type: 'text', text: result }],
    }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    }
  }
})

// Start
async function main() {
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Turbo Hub MCP Server running on stdio')
}

main().catch((err) => {
  console.error('MCP Server failed:', err)
  process.exit(1)
})
