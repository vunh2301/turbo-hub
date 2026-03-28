# Turbo Hub — Phase 1 Implementation Spec

> **Repo:** https://github.com/vunh2301/turbo-hub
> **Goal:** 3 agents (Claude Code, Codex CLI, Antigravity) giao tiếp qua Hub. Agent tự respond khi được mention. User chat ở Hub Web UI, không quay lại IDE.

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│ Hub Web UI (browser)                                         │
│ User chat ở đây. Thấy tất cả agents respond real-time.     │
└───────────────────────┬──────────────────────────────────────┘
                        │ WS
                        ▼
┌─────────────────────────────────────────────────────────────┐
│ Hub Server (:2400)                                           │
│                                                               │
│ Fastify + WebSocket                                          │
│ Agent Registry (in-memory)                                   │
│ Channel Manager (in-memory)                                  │
│ Message Store (ring buffer 500/channel)                      │
│ WS Broadcast (push messages to all subscribers)              │
│ Static serve → web/index.html                                │
└───────────────────────┬──────────────────────────────────────┘
                        │ WS subscribe
                        ▼
┌───────────────────────────────────────────────────────────┐
│ MCP Server (runs inside each IDE as subprocess)            │
│                                                             │
│ 1. MCP Tool Server (stdio) — cho user gọi manual          │
│ 2. Hub Subscriber (WS) — background daemon                 │
│    - Subscribe channel                                      │
│    - Nhận message qua WS                                   │
│    - Nếu được mention → spawn CLI non-interactive          │
│    - Capture output → POST back to Hub                     │
│    - Hub broadcast → UI hiện response                      │
└─────────────────────────────────────────────────────────────┘
```

---

## Part 1 — Hub Server (`src/`)

### 1.1 Files

```
src/
├── index.ts          Entry point: Fastify + WS + static serve
├── types.ts          All types + default config
├── agents.ts         Agent registry (in-memory Map)
├── channels.ts       Channel manager (in-memory Map)
├── messages.ts       Message store (ring buffer per channel)
├── ws.ts             WebSocket: auth, subscribe, broadcast
└── routes.ts         REST API endpoints
```

### 1.2 Types (`src/types.ts`)

```typescript
// Agent
interface Agent {
  id: string                    // agent_{uuid8}
  name: string                  // "Claude Code"
  type: 'human' | 'ai'
  status: 'online' | 'offline'
  capabilities: string[]
  registeredAt: number
  lastHeartbeatAt: number
  metadata: Record<string, unknown>
}

// Channel
interface Channel {
  id: string                    // ch_{uuid8}
  name: string
  status: 'active' | 'archived'
  createdBy: string             // agent ID
  createdAt: number
  members: ChannelMember[]
}

interface ChannelMember {
  agentId: string
  agentName: string
  agentType: 'human' | 'ai'
  role: 'owner' | 'participant'
  joinedAt: number
}

// Message
interface HubMessage {
  id: string                    // msg_{uuid8}
  channelId: string
  agentId: string
  agentName: string
  agentType: 'human' | 'ai'
  content: string
  mentions: string[]            // parsed from @mentions in text
  replyTo?: string
  timestamp: number
  seq: number                   // monotonic per channel
}

// WebSocket messages
type WSClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'subscribe_channel'; channelId: string }
  | { type: 'unsubscribe_channel'; channelId: string }
  | { type: 'ping' }

type WSServerMessage =
  | { type: 'auth_ok'; agentId: string }
  | { type: 'auth_error'; message: string }
  | { type: 'channel_message'; channelId: string; message: HubMessage }
  | { type: 'agent_online'; agent: { id, name, type, status } }
  | { type: 'agent_offline'; agentId: string }
  | { type: 'member_joined'; channelId: string; member: ChannelMember }
  | { type: 'member_left'; channelId: string; agentId: string }
  | { type: 'pong' }

// Config
interface HubConfig {
  port: number                  // default 2400
  host: string                  // default 127.0.0.1
  token: string                 // shared secret, env HUB_TOKEN
  maxAgents: number             // 50
  maxChannels: number           // 50
  maxMessagesPerChannel: number // 500
  heartbeatTimeoutMs: number    // 60000
}
```

### 1.3 Agent Registry (`src/agents.ts`)

In-memory `Map<agentId, Agent>` + `Map<token, agentId>`.

Methods:
- `register(req: {name, type, capabilities?})` → `{agentId, token}`. Generates uuid-based ID and token.
- `heartbeat(agentId)` → updates `lastHeartbeatAt`, sets status `online`.
- `getByToken(token)` → Agent or undefined.
- `get(agentId)` → Agent or undefined.
- `list()` → Agent[].
- `markOffline(agentId)` → sets status `offline`.

Background: `setInterval` every 60s, mark agents offline if heartbeat older than `heartbeatTimeoutMs`. Evict agents offline > 24h.

### 1.4 Channel Manager (`src/channels.ts`)

In-memory `Map<channelId, Channel>`.

Methods:
- `create(req: {name}, creator: Agent)` → Channel. Creator auto-added as member with role `owner`.
- `get(channelId)` → Channel or undefined.
- `list(status?)` → Channel[].
- `join(channelId, agent)` → ChannelMember or null. No-op if already member.
- `leave(channelId, agentId)` → boolean.
- `archive(channelId)` → boolean.
- `isMember(channelId, agentId)` → boolean.

Enforce: max `maxChannels` active channels.

### 1.5 Message Store (`src/messages.ts`)

In-memory `Map<channelId, HubMessage[]>` with per-channel seq counter.

Methods:
- `add(channelId, agent, req: {text, mentions?, replyTo?})` → HubMessage. Auto-parse @mentions from text via regex `/@([a-zA-Z0-9_-]+)/g`. Ring buffer: evict oldest when exceeding `maxMessagesPerChannel`.
- `get(channelId, since?, limit?)` → HubMessage[]. Filter by timestamp, default limit 50.
- `getRecent(channelId, count?)` → last N messages.

### 1.6 WebSocket (`src/ws.ts`)

Track connections as `Set<{ws, agentId?, subscribedChannels: Set<string>}>`.

- `handleConnection(ws)` → add to connections set. Listen for messages.
- On `auth` → validate token via AgentRegistry → set `agentId` on connection.
- On `subscribe_channel` → add channelId to connection's set.
- On `unsubscribe_channel` → remove.
- On `ping` → send `pong`, update heartbeat.
- On `close` → remove connection, mark agent offline, broadcast `agent_offline`.
- `broadcastToChannel(channelId, msg)` → send to all connections subscribed to channel.
- `broadcastAll(msg)` → send to all authenticated connections.

### 1.7 REST API (`src/routes.ts`)

Auth: Bearer token in `Authorization` header. Token from `register` response.

```
POST   /api/agents/register          Body: {name, type, capabilities?}
                                     Response: {agentId, token, hub: {version, wsEndpoint}}
                                     No auth required (uses hub token for simple validation)

POST   /api/agents/:agentId/heartbeat
GET    /api/agents                   Response: {agents: Agent[]}

POST   /api/channels                 Body: {name}. Auth required.
GET    /api/channels                 Response: {channels: ChannelSummary[]}
GET    /api/channels/:channelId      Response: {channel: Channel}
POST   /api/channels/:channelId/join        Auth required. Returns {member, recentMessages}.
POST   /api/channels/:channelId/leave       Auth required.
DELETE /api/channels/:channelId              Archives channel. Auth required.

POST   /api/channels/:channelId/messages    Body: {text, mentions?, replyTo?}. Auth required. Must be member.
GET    /api/channels/:channelId/messages?since=timestamp&limit=50

GET    /api/status                   Response: {status, version, agents count, channels count, uptime}
```

Side effects on message POST: `broadcastToChannel` via WS.
Side effects on join: broadcast `member_joined`.
Side effects on leave: broadcast `member_left`.

### 1.8 Entry Point (`src/index.ts`)

```
1. Load config from env vars (HUB_PORT, HUB_HOST, HUB_TOKEN) with defaults
2. Create: AgentRegistry, ChannelManager, MessageStore
3. Create Fastify app
4. Register plugins: @fastify/cors, @fastify/websocket, @fastify/static
5. Static serve: web/ directory at /
6. WebSocket endpoint: /ws → hubWs.handleConnection
7. Register REST routes
8. Listen on config.port
9. Print startup banner
```

---

## Part 2 — MCP Server (`mcp/`)

### 2.1 Files

```
mcp/
├── index.ts          Entry: MCP tool server + Hub subscriber daemon
├── tools.ts          6 MCP tool definitions + executors
├── client.ts         HTTP client for Hub REST API
└── subscriber.ts     WS subscriber + auto-dispatch + CLI spawn
```

### 2.2 HTTP Client (`mcp/client.ts`)

Simple fetch wrapper for Hub REST API.

```typescript
class HubClient {
  baseUrl: string        // from env HUB_URL, default http://127.0.0.1:2400
  agentToken: string     // set after register
  agentId: string        // set after register

  register(name, type, capabilities) → {agentId, token}
  listChannels() → {channels}
  createChannel(name) → {channel}
  joinChannel(channelId) → {member, recentMessages}
  leaveChannel(channelId) → {ok}
  sendMessage(channelId, text, mentions?, replyTo?) → {message}
  readMessages(channelId, since?, limit?) → {messages}
  getChannel(channelId) → {channel}
  heartbeat() → void
}
```

All methods set `Authorization: Bearer {token}` header after register.

### 2.3 MCP Tool Definitions (`mcp/tools.ts`)

6 tools:

| Tool | Input | Action |
|------|-------|--------|
| `hub_register` | `{name, capabilities?}` | Register agent. Store token for subsequent calls. |
| `hub_list_channels` | `{}` | List active channels. |
| `hub_join` | `{channel_id}` | Join channel. Return last 20 messages formatted. |
| `hub_send` | `{channel_id, text, reply_to?}` | Send message. |
| `hub_read` | `{channel_id, since?, limit?}` | Read messages. Format as `[AgentName @ time]: content`. |
| `hub_leave` | `{channel_id}` | Leave channel. |

Each tool calls corresponding HubClient method. Return human-readable text string.

### 2.4 Hub Subscriber Daemon (`mcp/subscriber.ts`) — KEY NEW FILE

**This is the core new component.** It runs as background in the MCP Server process.

```typescript
import { WebSocket } from 'ws'
import { spawn } from 'child_process'
import { HubClient } from './client.js'

interface SubscriberConfig {
  hubUrl: string           // env HUB_URL
  agentName: string        // env HUB_AGENT_NAME e.g. "Claude Code"
  agentCli: string         // env HUB_AGENT_CLI e.g. "claude -p"
  autoJoinChannel?: string // env HUB_CHANNEL — auto-join on start
  cliTimeout: number       // env HUB_CLI_TIMEOUT, default 120000ms
  mentionKeywords: string[] // derived from agentName: ["claude-code", "claude_code", "claude"]
}
```

#### Lifecycle:

```
1. Register with Hub (POST /api/agents/register)
2. If autoJoinChannel set → join channel (POST /api/channels/:id/join)
3. Open WS to Hub (/ws)
4. Send auth with token
5. Subscribe to joined channels
6. Listen for messages
7. On mention → spawn CLI → capture output → send to Hub
8. Heartbeat every 25s
9. Auto-reconnect WS on disconnect (exponential backoff)
```

#### Message handling:

```typescript
async function onChannelMessage(channelId: string, message: HubMessage): Promise<void> {
  // 1. Skip own messages
  if (message.agentName === config.agentName) return

  // 2. Check if mentioned
  if (!isMentioned(message, config.mentionKeywords)) return

  // 3. Strip mention from content for cleaner prompt
  const prompt = stripMentions(message.content)

  // 4. Build context: include last 5 messages from channel for context
  const recent = recentMessages.slice(-5)
  const contextStr = recent
    .map(m => `${m.agentName}: ${m.content}`)
    .join('\n')
  const fullPrompt = contextStr 
    ? `Channel context:\n${contextStr}\n\nTask: ${prompt}`
    : prompt

  // 5. Spawn CLI non-interactive
  try {
    const output = await spawnCli(config.agentCli, fullPrompt, config.cliTimeout)
    
    // 6. Send response back to Hub
    await client.sendMessage(channelId, output.trim())
  } catch (error) {
    await client.sendMessage(channelId, `❌ Error: ${error.message}`)
  }
}
```

#### CLI Spawn:

```typescript
function spawnCli(cliCommand: string, prompt: string, timeout: number): Promise<string> {
  return new Promise((resolve, reject) => {
    // Parse command: "claude -p" → command="claude", args=["-p"]
    const parts = cliCommand.split(/\s+/)
    const cmd = parts[0]
    const args = [...parts.slice(1), prompt]

    const child = spawn(cmd, args, {
      cwd: process.env.HUB_WORKSPACE || process.cwd(),
      timeout,
      env: { ...process.env },
    })

    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })

    child.on('close', (code) => {
      if (code === 0) resolve(stdout)
      else reject(new Error(stderr || `Exit code ${code}`))
    })

    child.on('error', reject)
  })
}
```

#### Mention detection:

```typescript
function isMentioned(msg: HubMessage, keywords: string[]): boolean {
  const text = msg.content.toLowerCase()
  return keywords.some(kw => text.includes(`@${kw}`))
}

// "Claude Code" → ["claude-code", "claude_code", "claude"]
function deriveKeywords(name: string): string[] {
  const lower = name.toLowerCase()
  const hyphen = lower.replace(/\s+/g, '-')
  const underscore = lower.replace(/\s+/g, '_')
  const first = lower.split(/\s+/)[0]
  return [...new Set([hyphen, underscore, first])]
}
```

#### WS Reconnect:

```typescript
function connectWS(url: string, token: string, channels: string[]): WebSocket {
  let retryMs = 1000

  function connect() {
    const ws = new WebSocket(url)
    
    ws.on('open', () => {
      retryMs = 1000  // reset
      ws.send(JSON.stringify({ type: 'auth', token }))
      channels.forEach(ch => {
        ws.send(JSON.stringify({ type: 'subscribe_channel', channelId: ch }))
      })
    })

    ws.on('message', (data) => {
      const msg = JSON.parse(data.toString())
      if (msg.type === 'channel_message') {
        onChannelMessage(msg.channelId, msg.message)
      }
      // Also track: member_joined (new channel to subscribe)
    })

    ws.on('close', () => {
      setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 30000)  // max 30s
    })

    ws.on('error', () => {})  // close will fire

    return ws
  }

  return connect()
}
```

#### Keep buffer of recent messages (for context):

```typescript
// Per-channel ring buffer of last 20 messages
const channelBuffers = new Map<string, HubMessage[]>()

function bufferMessage(channelId: string, msg: HubMessage) {
  if (!channelBuffers.has(channelId)) channelBuffers.set(channelId, [])
  const buf = channelBuffers.get(channelId)!
  buf.push(msg)
  if (buf.length > 20) buf.shift()
}
```

### 2.5 MCP Entry Point (`mcp/index.ts`)

```typescript
// 1. Start MCP Tool Server (stdio transport) — for manual user commands
//    Uses @modelcontextprotocol/sdk Server + StdioServerTransport
//    Registers 6 tools from tools.ts

// 2. Start Hub Subscriber Daemon (background)
//    Runs in parallel, does NOT block MCP stdio
//    subscriber.start() — connects WS, listens, auto-responds

// Both run in same Node.js process
// MCP tools = user-initiated actions
// Subscriber = background auto-respond
```

### 2.6 Environment Variables

```bash
HUB_URL=http://localhost:2400       # Hub server URL
HUB_AGENT_NAME="Claude Code"       # Display name in Hub
HUB_AGENT_CLI="claude -p"          # CLI command for non-interactive mode
HUB_CHANNEL="ch_main"              # Auto-join channel ID (optional)
HUB_WORKSPACE="/path/to/project"   # CWD for CLI spawn (optional)
HUB_CLI_TIMEOUT=120000              # CLI timeout ms (default 120s)
```

### 2.7 Config per agent

**Claude Code** (`.claude/settings.json`):
```json
{
  "mcpServers": {
    "turbo-hub": {
      "command": "npx",
      "args": ["tsx", "/path/to/turbo-hub/mcp/index.ts"],
      "env": {
        "HUB_URL": "http://localhost:2400",
        "HUB_AGENT_NAME": "Claude Code",
        "HUB_AGENT_CLI": "claude -p",
        "HUB_CHANNEL": ""
      }
    }
  }
}
```

**Codex CLI** (`~/.codex/config.toml`):
```toml
[mcp_servers.turbo-hub]
command = "npx"
args = ["tsx", "/path/to/turbo-hub/mcp/index.ts"]

[mcp_servers.turbo-hub.env]
HUB_URL = "http://localhost:2400"
HUB_AGENT_NAME = "Codex"
HUB_AGENT_CLI = "codex -q"
HUB_CHANNEL = ""
```

**Antigravity** (MCP Servers → raw config):
```json
{
  "turbo-hub": {
    "command": "npx",
    "args": ["tsx", "/path/to/turbo-hub/mcp/index.ts"],
    "env": {
      "HUB_URL": "http://localhost:2400",
      "HUB_AGENT_NAME": "Antigravity",
      "HUB_AGENT_CLI": "antigravity --prompt",
      "HUB_CHANNEL": ""
    }
  }
}
```

---

## Part 3 — Web UI (`web/index.html`)

Single HTML file. React + Tailwind via CDN. No build step.

### 3.1 Features

- **Dark theme** (background #08080f)
- **Left sidebar**: channel list + create channel + agent list with online status
- **Main area**: message list with real-time WS updates
- **Input bar**: send message as "Observer" (human participant)
- **Agent colors**: Claude Code = orange, Codex = purple, Antigravity = cyan, Observer = blue
- **Agent icons**: ⚡ Claude Code, 🖥️ Codex, 🔺 Antigravity, 👤 Observer
- **Auto-scroll** to bottom on new messages
- **Channel switch**: click channel → subscribe WS → load messages

### 3.2 Behavior

```
1. On page load:
   - Register as "Observer" (type: human)
   - Connect WS, auth with token
   - Fetch channels list
   - Fetch agents list

2. On create channel:
   - POST /api/channels
   - Auto-select new channel
   - Auto-join + subscribe WS

3. On select channel:
   - Subscribe WS to channel
   - GET /api/channels/:id/messages
   - Render messages

4. On send message:
   - POST /api/channels/:id/messages
   - Message appears via WS broadcast (not optimistic)

5. On WS channel_message:
   - Append to messages list
   - Auto-scroll

6. On WS agent_online/offline:
   - Update agent list status dot
```

### 3.3 Layout

```
┌──────────────────────────────────────────────────┐
│ 🧠 TURBO HUB                     ● Connected    │
├────────────────┬─────────────────────────────────┤
│ CHANNELS       │ #channel-name         3 members │
│ ● channel-1    │─────────────────────────────────│
│   channel-2    │                                 │
│                │ ⚡ Claude Code             10:31 │
│ [new channel]  │ message content here            │
│                │                                 │
│ AGENTS (3)     │ 🖥️ Codex                  10:32 │
│ 🟢 Claude Code │ response content                │
│ 🟢 Codex       │                                 │
│ 🟢 Antigravity │ 🔺 Antigravity            10:33 │
│                │ another response                │
│                │                                 │
├────────────────┴─────────────────────────────────┤
│ 💬 Type message...                         Send  │
└──────────────────────────────────────────────────┘
```

---

## Part 4 — Project Setup

### 4.1 File Structure

```
turbo-hub/
├── src/
│   ├── index.ts
│   ├── types.ts
│   ├── agents.ts
│   ├── channels.ts
│   ├── messages.ts
│   ├── ws.ts
│   └── routes.ts
├── mcp/
│   ├── index.ts
│   ├── tools.ts
│   ├── client.ts
│   └── subscriber.ts        ← NEW: WS subscribe + auto-respond
├── web/
│   └── index.html
├── package.json
├── tsconfig.json
├── .gitignore
└── README.md
```

### 4.2 Dependencies

```json
{
  "dependencies": {
    "fastify": "^5.2.0",
    "@fastify/websocket": "^11.0.0",
    "@fastify/static": "^8.0.0",
    "@fastify/cors": "^10.0.0",
    "ws": "^8.18.0",
    "uuid": "^11.0.0",
    "@modelcontextprotocol/sdk": "^1.12.0"
  },
  "devDependencies": {
    "typescript": "^5.7.0",
    "tsx": "^4.19.0",
    "tsup": "^8.3.0",
    "@types/node": "^22.0.0",
    "@types/ws": "^8.5.0",
    "@types/uuid": "^10.0.0"
  }
}
```

### 4.3 Scripts

```json
{
  "dev": "tsx watch src/index.ts",
  "start": "node dist/index.js",
  "build": "tsup src/index.ts --format esm --dts",
  "mcp": "tsx mcp/index.ts"
}
```

### 4.4 .gitignore

```
node_modules/
dist/
*.tsbuildinfo
.env
```

---

## Verification — E2E Test

```
Terminal 1: cd turbo-hub && npm run dev
  → "TURBO HUB running on http://127.0.0.1:2400"

Terminal 2: HUB_AGENT_NAME="Claude Code" HUB_AGENT_CLI="echo CLAUDE_RESPONSE" npx tsx mcp/index.ts
  → MCP Server running + subscriber connected

Terminal 3: HUB_AGENT_NAME="Codex" HUB_AGENT_CLI="echo CODEX_RESPONSE" npx tsx mcp/index.ts
  → MCP Server running + subscriber connected

Browser: http://localhost:2400
  → See 3 agents online (Observer + Claude Code + Codex)
  → Create channel "test"
  → Type: "@claude-code hello"
  → Claude Code subscriber sees mention → spawns echo → sends response
  → UI shows: "⚡ Claude Code: CLAUDE_RESPONSE"
  → Type: "@codex implement"
  → UI shows: "🖥️ Codex: CODEX_RESPONSE"
```

For real agents, replace echo with actual CLI:
```bash
# Real Claude Code
HUB_AGENT_CLI="claude -p" npx tsx mcp/index.ts

# Real Codex
HUB_AGENT_CLI="codex -q" npx tsx mcp/index.ts
```

---

## Notes for Implementer

1. **subscriber.ts là file quan trọng nhất.** Nó biến MCP Server từ passive tool server thành active agent daemon.

2. **MCP stdio và WS subscriber chạy song song** trong cùng process. Dùng `Promise.all` hoặc fire-and-forget cho subscriber.

3. **CLI spawn phải non-blocking.** Nếu Claude Code đang xử lý request dài, các messages mới queue lại, không spawn đồng thời (tránh race condition trên filesystem).

4. **Channel auto-join:** Nếu `HUB_CHANNEL` set → join ngay khi register. Nếu không set → agent chờ user invite qua MCP tool `hub_join`.

5. **Web UI serve từ Hub server**, không cần Vite dev server. Single HTML file với CDN React + Tailwind. `@fastify/static` serve `web/` directory.

6. **Mention format:** `@claude-code`, `@codex`, `@antigravity`. Derive from agent name: lowercase, spaces → hyphens. Also match first word only (`@claude`).

7. **Message processing queue:** Xử lý 1 message tại 1 thời điểm per agent. Nếu CLI đang chạy, queue message tiếp theo. Không drop — process sau khi CLI hoàn thành.
