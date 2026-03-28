import { spawn } from 'child_process'
import WebSocket from 'ws'
import { HubClient } from './client.js'

// ─── Config ──────────────────────────────────────────────────────────────────

interface SubscriberConfig {
  hubUrl: string
  agentName: string
  agentCli: string         // e.g. "claude -p" or "codex -q"
  autoJoinChannel?: string // HUB_CHANNEL — join immediately on start
  workspace: string        // cwd for CLI spawn
  cliTimeout: number       // ms, default 120000
  mentionKeywords: string[] // derived from agentName
  respondAll: boolean      // HUB_RESPOND_ALL=true → respond to all messages, not just mentions
}

function loadConfig(): SubscriberConfig {
  const agentName = process.env.HUB_AGENT_NAME || ''
  return {
    hubUrl: process.env.HUB_URL || 'http://127.0.0.1:2400',
    agentName,
    agentCli: process.env.HUB_AGENT_CLI || '',
    autoJoinChannel: process.env.HUB_CHANNEL || undefined,
    workspace: process.env.HUB_WORKSPACE || process.cwd(),
    cliTimeout: Number(process.env.HUB_CLI_TIMEOUT) || 120_000,
    mentionKeywords: deriveKeywords(agentName),
    respondAll: process.env.HUB_RESPOND_ALL === 'true',
  }
}

// "Claude Code" → ["claude-code", "claude_code", "claude"]
function deriveKeywords(name: string): string[] {
  const lower = name.toLowerCase()
  const hyphen = lower.replace(/\s+/g, '-')
  const underscore = lower.replace(/\s+/g, '_')
  const first = lower.split(/\s+/)[0]
  return [...new Set([hyphen, underscore, first].filter(Boolean))]
}

// ─── Message buffer (last 20 per channel for context) ────────────────────────

const channelBuffers = new Map<string, Array<{ agentName: string; content: string }>>()

function bufferMessage(channelId: string, agentName: string, content: string) {
  if (!channelBuffers.has(channelId)) channelBuffers.set(channelId, [])
  const buf = channelBuffers.get(channelId)!
  buf.push({ agentName, content })
  if (buf.length > 20) buf.shift()
}

// ─── Mention detection ───────────────────────────────────────────────────────

function isMentioned(content: string, keywords: string[]): boolean {
  const lower = content.toLowerCase()
  return keywords.some(kw => lower.includes(`@${kw}`))
}

function stripMentions(content: string): string {
  return content.replace(/@[\w-]+/g, '').trim()
}

// ─── CLI spawn ───────────────────────────────────────────────────────────────

function spawnCli(cliCommand: string, prompt: string, timeout: number, workspace: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts = cliCommand.trim().split(/\s+/)
    const cmd = parts[0]
    const args = [...parts.slice(1), prompt]

    const child = spawn(cmd, args, {
      cwd: workspace,
      timeout,
      env: { ...process.env, HUB_SUBSCRIBER_DISABLED: 'true' },
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'], // ignore stdin — MCP uses it for protocol
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d: Buffer) => { stdout += d.toString() })
    child.stderr.on('data', (d: Buffer) => { stderr += d.toString() })

    child.on('close', (code) => {
      if (code === 0 || stdout.trim()) resolve(stdout.trim())
      else reject(new Error(stderr.trim() || `CLI exited with code ${code}`))
    })

    child.on('error', reject)
  })
}

// ─── Sequential queue ────────────────────────────────────────────────────────
// Option A: process one message at a time, never drop, queue all pending

let queue: Promise<void> = Promise.resolve()

function enqueue(task: () => Promise<void>): void {
  queue = queue.then(() => task().catch((err) => {
    console.error('[subscriber] task error:', err?.message ?? err)
  }))
}

// ─── Core message handler ────────────────────────────────────────────────────

async function handleMessage(
  channelId: string,
  message: { agentId: string; agentName: string; agentType: string; content: string },
  config: SubscriberConfig,
  client: HubClient,
): Promise<void> {
  // Buffer every message for context (even own messages)
  bufferMessage(channelId, message.agentName, message.content)

  // Skip system and own messages
  if (message.agentType === 'system') return
  if (message.agentId === client.agentId) return
  if (!config.agentCli) return

  // Respond when mentioned, or always if respondAll mode
  const mentioned = isMentioned(message.content, config.mentionKeywords)
  if (!config.respondAll && !mentioned) return

  const prompt = mentioned
    ? stripMentions(message.content)
    : message.content
  if (!prompt) return

  // Build context from recent buffer
  const recent = (channelBuffers.get(channelId) ?? []).slice(-6, -1) // last 5 before current
  const contextStr = recent.map(m => `${m.agentName}: ${m.content}`).join('\n')
  const fullPrompt = contextStr
    ? `Channel context:\n${contextStr}\n\nTask: ${prompt}`
    : prompt

  enqueue(async () => {
    console.error(`[subscriber] mentioned in ${channelId}, spawning CLI...`)
    try {
      const output = await spawnCli(config.agentCli, fullPrompt, config.cliTimeout, config.workspace)
      await client.sendMessage(channelId, output)
      console.error(`[subscriber] replied to ${channelId}`)
    } catch (err: any) {
      await client.sendMessage(channelId, `❌ ${err.message}`)
    }
  })
}

// ─── WS connection ───────────────────────────────────────────────────────────

let _ws: WebSocket | null = null
// Initialize eagerly so subscribeChannel() can be called before startSubscriber() completes
const _subscribedChannels = new Set<string>()

// Called by MCP tools (hub_join) — safe to call before subscriber is ready
export function subscribeChannel(channelId: string): void {
  _subscribedChannels.add(channelId)
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: 'subscribe_channel', channelId }))
    console.error(`[subscriber] subscribed to channel ${channelId}`)
  }
  // If WS not yet connected, channel will be subscribed in the 'open' handler
}

export function unsubscribeChannel(channelId: string): void {
  _subscribedChannels.delete(channelId)
  if (_ws?.readyState === WebSocket.OPEN) {
    _ws.send(JSON.stringify({ type: 'unsubscribe_channel', channelId }))
  }
}

function startWS(
  wsUrl: string,
  token: string,
  config: SubscriberConfig,
  client: HubClient,
): void {
  let retryMs = 1_000

  function connect() {
    const ws = new WebSocket(wsUrl)
    _ws = ws

    ws.on('open', () => {
      retryMs = 1_000
      ws.send(JSON.stringify({ type: 'auth', token }))
      for (const ch of _subscribedChannels) {
        ws.send(JSON.stringify({ type: 'subscribe_channel', channelId: ch }))
      }
      console.error(`[subscriber] WS connected, watching ${_subscribedChannels.size} channel(s)`)
    })

    ws.on('message', (data: Buffer) => {
      try {
        const msg = JSON.parse(data.toString())
        if (msg.type === 'channel_message') {
          handleMessage(msg.channelId, msg.message, config, client)
        }
      } catch {
        // ignore malformed
      }
    })

    ws.on('close', () => {
      _ws = null
      console.error(`[subscriber] WS disconnected, retry in ${retryMs}ms`)
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 30_000)
    })

    ws.on('error', () => {
      // 'close' fires after 'error', handled there
    })

    // Keepalive
    const ping = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }))
      }
    }, 25_000)

    ws.on('close', () => clearInterval(ping))
  }

  connect()
}

// ─── Entry ───────────────────────────────────────────────────────────────────

export async function startSubscriber(): Promise<void> {
  // Prevent recursive spawn: child `claude -p` processes must not start their own subscriber
  if (process.env.HUB_SUBSCRIBER_DISABLED === 'true') return

  const config = loadConfig()

  // Skip if no CLI configured
  if (!config.agentCli) {
    console.error('[subscriber] HUB_AGENT_CLI not set, auto-respond disabled')
    return
  }
  if (!config.agentName) {
    console.error('[subscriber] HUB_AGENT_NAME not set, subscriber disabled')
    return
  }

  const client = new HubClient(config.hubUrl)

  // Register
  const { token } = await client.register(config.agentName, 'ai', ['auto_respond'])
  console.error(`[subscriber] registered as "${config.agentName}" (${client.agentId})`)

  // Auto-join channel if configured (adds to the shared _subscribedChannels set)
  if (config.autoJoinChannel) {
    try {
      await client.joinChannel(config.autoJoinChannel)
      _subscribedChannels.add(config.autoJoinChannel)
      console.error(`[subscriber] auto-joined channel ${config.autoJoinChannel}`)
    } catch (err: any) {
      console.error(`[subscriber] auto-join failed: ${err.message}`)
    }
  }

  // Start WS daemon — uses shared _subscribedChannels (may already have channels from hub_join calls)
  const wsUrl = config.hubUrl.replace(/^http/, 'ws') + '/ws'
  startWS(wsUrl, token, config, client)

  // Heartbeat every 25s
  setInterval(async () => {
    try { await client.heartbeat() } catch { /* ignore */ }
  }, 25_000)
}
