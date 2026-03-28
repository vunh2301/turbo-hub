#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

import { HubClient } from './client.js'
import { getToolDefinitions, executeTool } from './tools.js'

const client = new HubClient(process.env.HUB_URL)

const server = new Server(
  {
    name: 'turbo-hub',
    version: '0.1.0',
  },
  {
    capabilities: {
      tools: {},
    },
  }
)

// List tools
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: getToolDefinitions(),
}))

// Execute tool
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params

  try {
    const result = await executeTool(client, name, args ?? {})
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
