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
import { startSubscriber } from './subscriber.js'

// MCP tool client — for user-initiated tool calls (hub_register, hub_join, etc.)
const client = new HubClient(process.env.HUB_URL)
const wsClient = new HubWsClient(process.env.HUB_URL || 'http://127.0.0.1:2400')

const server = new Server(
  { name: 'turbo-hub', version: '0.1.0' },
  { capabilities: { tools: {} } }
)

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}))

// Execute tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params
  try {
    const result = await executeTool(client, wsClient, name, args ?? {})
    return { content: [{ type: 'text', text: result }] }
  } catch (error: any) {
    return {
      content: [{ type: 'text', text: `Error: ${error.message}` }],
      isError: true,
    }
  }
})

// Start
async function main() {
  // 1. Start MCP stdio server (for user tool calls)
  const transport = new StdioServerTransport()
  await server.connect(transport)
  console.error('Turbo Hub MCP Server running on stdio')

  // 2. Start subscriber daemon in background (for auto-respond on @mention)
  //    Fire-and-forget — errors are logged, never crash the MCP server
  startSubscriber().catch((err) => {
    console.error('[subscriber] failed to start:', err?.message ?? err)
  })
}

main().catch((err) => {
  console.error('MCP Server failed:', err)
  process.exit(1)
})
