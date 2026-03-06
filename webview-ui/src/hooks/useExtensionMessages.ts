import { useState, useEffect, useRef, type Dispatch, type SetStateAction } from 'react'
import type { OfficeState } from '../office/engine/officeState.js'
import type { OfficeLayout, ToolActivity } from '../office/types.js'
import { extractToolName } from '../office/toolUtils.js'
import { migrateLayoutColors } from '../office/layout/layoutSerializer.js'
import { buildDynamicCatalog } from '../office/layout/furnitureCatalog.js'
import { setFloorSprites } from '../office/floorTiles.js'
import { setWallSprites } from '../office/wallTiles.js'
import { setCharacterTemplates } from '../office/sprites/spriteData.js'
import { IS_VSCODE_API_AVAILABLE, vscode } from '../vscodeApi.js'
import { playDoneSound, setSoundEnabled } from '../notificationSound.js'

export interface SubagentCharacter {
  id: number
  parentAgentId: number
  parentToolId: string
  label: string
}

export interface FurnitureAsset {
  id: string
  name: string
  label: string
  category: string
  file: string
  width: number
  height: number
  footprintW: number
  footprintH: number
  isDesk: boolean
  canPlaceOnWalls: boolean
  partOfGroup?: boolean
  groupId?: string
  canPlaceOnSurfaces?: boolean
  backgroundTiles?: number
}

export interface WorkspaceFolder {
  name: string
  path: string
}

export interface ExtensionMessageState {
  agents: number[]
  selectedAgent: number | null
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  subagentCharacters: SubagentCharacter[]
  layoutReady: boolean
  loadedAssets?: { catalog: FurnitureAsset[]; sprites: Record<string, string[][]> }
  workspaceFolders: WorkspaceFolder[]
}

const GATEWAY_SETTINGS_KEY = 'openclaw.control.settings.v1'
const GATEWAY_CONNECT_DELAY_MS = 750
const GATEWAY_RECONNECT_BASE_MS = 1200
const GATEWAY_RECONNECT_MAX_MS = 15_000
const GATEWAY_POLL_INTERVAL_MS = 8_000
const GATEWAY_REQUEST_TIMEOUT_MS = 12_000
const GATEWAY_RECENT_ACTIVE_WINDOW_MS = 120_000
const GATEWAY_WAITING_WINDOW_MS = 300_000

const DEFAULT_BROWSER_AGENTS: Array<{ id: string; name: string }> = [
  { id: 'main', name: 'Workspace Sovereign' },
  { id: 'sovereign-aegis', name: 'Sovereign-Aegis' },
  { id: 'sovereign-apex', name: 'Sovereign-Apex' },
  { id: 'sovereign-bastion', name: 'Sovereign-Bastion' },
  { id: 'sovereign-herald', name: 'Sovereign-Herald' },
  { id: 'sovereign-oracle', name: 'Sovereign-Oracle' },
  { id: 'sovereign-sentinel', name: 'Sovereign-Sentinel' },
]

interface GatewayStoredSettings {
  gatewayUrl?: string
  token?: string
  password?: string
}

interface BrowserAgentSnapshot {
  id: string
  name: string
  numericId: number
  active: boolean
  status?: string
  tools: ToolActivity[]
  recentAgeMs?: number
}

interface PendingGatewayRequest {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  timer: number
}

function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function getDefaultGatewayUrl(): string {
  return window.location.hostname === '127.0.0.1' || window.location.hostname === 'localhost'
    ? `ws://${window.location.host}`
    : 'ws://127.0.0.1:18789'
}

function readGatewaySettings(): { url: string; token?: string; password?: string } {
  const search = new URLSearchParams(window.location.search)
  const hash = new URLSearchParams(window.location.hash.startsWith('#') ? window.location.hash.slice(1) : window.location.hash)

  const gatewayUrl = asNonEmptyString(search.get('gatewayUrl') ?? hash.get('gatewayUrl'))
  const gatewayToken = asNonEmptyString(search.get('gatewayToken') ?? hash.get('gatewayToken') ?? hash.get('token'))
  const gatewayPassword = asNonEmptyString(search.get('gatewayPassword') ?? hash.get('gatewayPassword'))

  let stored: GatewayStoredSettings | null = null
  try {
    const raw = window.localStorage.getItem(GATEWAY_SETTINGS_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as unknown
      if (isRecord(parsed)) {
        stored = parsed as GatewayStoredSettings
      }
    }
  } catch {
    stored = null
  }

  const url = gatewayUrl ?? asNonEmptyString(stored?.gatewayUrl) ?? getDefaultGatewayUrl()
  const token = gatewayToken ?? asNonEmptyString(stored?.token)
  const password = gatewayPassword ?? asNonEmptyString(stored?.password)

  try {
    window.localStorage.setItem(
      GATEWAY_SETTINGS_KEY,
      JSON.stringify({ gatewayUrl: url, token: token ?? '', password: password ?? '' }),
    )
  } catch {
    // Ignore storage failures in private mode or sandboxed environments.
  }

  return { url, token, password }
}

function createRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`
}

function startBrowserTelemetry(args: {
  officeState: OfficeState
  setAgents: Dispatch<SetStateAction<number[]>>
  setSelectedAgent: Dispatch<SetStateAction<number | null>>
  setAgentTools: Dispatch<SetStateAction<Record<number, ToolActivity[]>>>
  setAgentStatuses: Dispatch<SetStateAction<Record<number, string>>>
}): () => void {
  const { officeState, setAgents, setSelectedAgent, setAgentTools, setAgentStatuses } = args
  const settings = readGatewaySettings()
  const agentIdMap = new Map<string, number>()

  let nextNumericId = 1
  let socket: WebSocket | null = null
  let reconnectTimer: number | null = null
  let connectDelayTimer: number | null = null
  let pollTimer: number | null = null
  let connectInFlight = false
  let syncInFlight = false
  let reconnectDelay = GATEWAY_RECONNECT_BASE_MS
  let disposed = false

  const pending = new Map<string, PendingGatewayRequest>()

  const clearTimer = (timer: number | null): void => {
    if (timer !== null) {
      window.clearTimeout(timer)
    }
  }

  const clearReconnectTimer = (): void => {
    clearTimer(reconnectTimer)
    reconnectTimer = null
  }

  const clearConnectDelayTimer = (): void => {
    clearTimer(connectDelayTimer)
    connectDelayTimer = null
  }

  const clearPollTimer = (): void => {
    clearTimer(pollTimer)
    pollTimer = null
  }

  const rejectAllPending = (reason: string): void => {
    for (const request of pending.values()) {
      window.clearTimeout(request.timer)
      request.reject(new Error(reason))
    }
    pending.clear()
  }

  const getNumericIdForAgent = (agentId: string): number => {
    const existing = agentIdMap.get(agentId)
    if (existing !== undefined) return existing
    const created = nextNumericId++
    agentIdMap.set(agentId, created)
    return created
  }

  const syncAgentRoster = (agents: Array<{ id: string; name: string }>): void => {
    const seenIds = new Set<string>()

    for (const agent of agents) {
      seenIds.add(agent.id)
      const numericId = getNumericIdForAgent(agent.id)
      const existing = officeState.characters.get(numericId)
      if (existing) {
        existing.folderName = agent.name
      } else {
        officeState.addAgent(numericId, undefined, undefined, undefined, true, agent.name)
      }
    }

    for (const [agentId, numericId] of [...agentIdMap.entries()]) {
      if (seenIds.has(agentId)) continue
      agentIdMap.delete(agentId)
      officeState.removeAgent(numericId)
    }
  }

  const applySnapshots = (snapshots: BrowserAgentSnapshot[]): void => {
    const orderedAgents = snapshots.map((snapshot) => snapshot.numericId).sort((a, b) => a - b)
    const nextTools: Record<number, ToolActivity[]> = {}
    const nextStatuses: Record<number, string> = {}

    for (const snapshot of snapshots) {
      nextTools[snapshot.numericId] = snapshot.tools
      if (snapshot.status && snapshot.status !== 'active') {
        nextStatuses[snapshot.numericId] = snapshot.status
      }

      const activeTool = snapshot.tools.find((tool) => !tool.done) ?? snapshot.tools[0]
      officeState.setAgentTool(snapshot.numericId, activeTool ? extractToolName(activeTool.status) : null)
      officeState.setAgentActive(snapshot.numericId, snapshot.active)
    }

    setAgents(orderedAgents)
    setAgentTools(nextTools)
    setAgentStatuses(nextStatuses)
    setSelectedAgent((previous) => {
      if (previous !== null && orderedAgents.includes(previous)) return previous
      return orderedAgents[0] ?? null
    })
  }

  const seedFromMessage = (message: string): void => {
    const seeded = DEFAULT_BROWSER_AGENTS.map((agent, index): BrowserAgentSnapshot => {
      const numericId = getNumericIdForAgent(agent.id)
      const existing = officeState.characters.get(numericId)
      if (existing) {
        existing.folderName = agent.name
      } else {
        officeState.addAgent(numericId, undefined, undefined, undefined, true, agent.name)
      }

      const active = index < 2
      return {
        id: agent.id,
        name: agent.name,
        numericId,
        active,
        tools: active
          ? [{ toolId: `seed-${agent.id}`, status: message, done: false }]
          : [],
      }
    })

    applySnapshots(seeded)
  }

  const requestGateway = (method: string, params: Record<string, unknown> = {}): Promise<unknown> => {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error('gateway not connected'))
    }

    const id = createRequestId()
    const payload = { type: 'req', id, method, params }

    return new Promise((resolve, reject) => {
      const timer = window.setTimeout(() => {
        pending.delete(id)
        reject(new Error(`gateway request timed out: ${method}`))
      }, GATEWAY_REQUEST_TIMEOUT_MS)

      pending.set(id, { resolve, reject, timer })
      socket?.send(JSON.stringify(payload))
    })
  }

  const parseGatewaySnapshots = (payloads: {
    agents: unknown
    status: unknown
    cron: unknown
  }): BrowserAgentSnapshot[] => {
    const declaredAgentsRaw = isRecord(payloads.agents) && Array.isArray(payloads.agents.agents)
      ? payloads.agents.agents
      : []

    const declaredAgents = declaredAgentsRaw
      .map((entry) => {
        if (!isRecord(entry)) return null
        const id = asNonEmptyString(entry.id)
        if (!id) return null
        const name = asNonEmptyString(entry.name) ?? id
        return { id, name }
      })
      .filter((entry): entry is { id: string; name: string } => Boolean(entry))

    const recentAgeByAgent = new Map<string, number>()
    const statusRecent =
      isRecord(payloads.status) &&
      isRecord(payloads.status.sessions) &&
      Array.isArray(payloads.status.sessions.recent)
        ? payloads.status.sessions.recent
        : []

    for (const session of statusRecent) {
      if (!isRecord(session)) continue
      const agentId = asNonEmptyString(session.agentId)
      const age = typeof session.age === 'number' && Number.isFinite(session.age) && session.age >= 0
        ? session.age
        : undefined
      if (!agentId || age === undefined) continue
      const existing = recentAgeByAgent.get(agentId)
      if (existing === undefined || age < existing) {
        recentAgeByAgent.set(agentId, age)
      }
    }

    const runningCronByAgent = new Map<string, Array<{ id: string; name: string; runningAtMs: number }>>()
    const cronJobs = isRecord(payloads.cron) && Array.isArray(payloads.cron.jobs) ? payloads.cron.jobs : []

    for (const job of cronJobs) {
      if (!isRecord(job)) continue
      const agentId = asNonEmptyString(job.agentId)
      const id = asNonEmptyString(job.id)
      if (!agentId || !id) continue
      const runningAtMs =
        isRecord(job.state) && typeof job.state.runningAtMs === 'number' && Number.isFinite(job.state.runningAtMs)
          ? job.state.runningAtMs
          : undefined
      if (runningAtMs === undefined) continue

      const running = runningCronByAgent.get(agentId) ?? []
      running.push({ id, name: asNonEmptyString(job.name) ?? 'cron job', runningAtMs })
      runningCronByAgent.set(agentId, running)
    }

    const mergedAgentNames = new Map<string, string>()
    for (const agent of declaredAgents) {
      mergedAgentNames.set(agent.id, agent.name)
    }
    for (const [agentId] of recentAgeByAgent) {
      if (!mergedAgentNames.has(agentId)) mergedAgentNames.set(agentId, agentId)
    }
    for (const [agentId] of runningCronByAgent) {
      if (!mergedAgentNames.has(agentId)) mergedAgentNames.set(agentId, agentId)
    }

    const roster = mergedAgentNames.size > 0
      ? [...mergedAgentNames.entries()].map(([id, name]) => ({ id, name }))
      : DEFAULT_BROWSER_AGENTS

    syncAgentRoster(roster)

    const snapshots = roster.map((agent): BrowserAgentSnapshot => {
      const numericId = getNumericIdForAgent(agent.id)
      const runningCron = runningCronByAgent.get(agent.id) ?? []
      const recentAgeMs = recentAgeByAgent.get(agent.id)

      let tools: ToolActivity[] = []
      let status: string | undefined
      let active = false

      if (runningCron.length > 0) {
        active = true
        tools = runningCron.slice(0, 3).map((job) => {
          const elapsedSec = Math.max(0, Math.floor((Date.now() - job.runningAtMs) / 1000))
          return {
            toolId: `cron:${job.id}`,
            status: `Running ${job.name} (${elapsedSec}s)`,
            done: false,
          }
        })
      } else if (typeof recentAgeMs === 'number' && recentAgeMs <= GATEWAY_RECENT_ACTIVE_WINDOW_MS) {
        active = true
        tools = [{
          toolId: `recent:${agent.id}`,
          status: `Recent activity ${Math.max(1, Math.floor(recentAgeMs / 1000))}s ago`,
          done: false,
        }]
      } else if (typeof recentAgeMs === 'number' && recentAgeMs <= GATEWAY_WAITING_WINDOW_MS) {
        status = 'waiting'
      }

      return { id: agent.id, name: agent.name, numericId, active, status, tools, recentAgeMs }
    })

    if (!snapshots.some((snapshot) => snapshot.active) && snapshots.length > 0) {
      const byRecent = [...snapshots].sort(
        (a, b) => (a.recentAgeMs ?? Number.MAX_SAFE_INTEGER) - (b.recentAgeMs ?? Number.MAX_SAFE_INTEGER),
      )
      for (const snapshot of byRecent.slice(0, Math.min(2, byRecent.length))) {
        snapshot.active = true
        snapshot.tools = [{ toolId: `heartbeat:${snapshot.id}`, status: 'Standby heartbeat', done: false }]
      }
    }

    return snapshots
  }

  const scheduleNextSync = (): void => {
    clearPollTimer()
    pollTimer = window.setTimeout(() => {
      void syncNow()
    }, GATEWAY_POLL_INTERVAL_MS)
  }

  const syncNow = async (): Promise<void> => {
    if (disposed || syncInFlight || !socket || socket.readyState !== WebSocket.OPEN) return
    syncInFlight = true

    try {
      const [agentsPayload, statusPayload, cronPayload] = await Promise.all([
        requestGateway('agents.list', {}),
        requestGateway('status', {}),
        requestGateway('cron.list', { includeDisabled: true, limit: 200 }),
      ])

      const snapshots = parseGatewaySnapshots({
        agents: isRecord(agentsPayload) ? agentsPayload : {},
        status: isRecord(statusPayload) ? statusPayload : {},
        cron: isRecord(cronPayload) ? cronPayload : {},
      })
      applySnapshots(snapshots)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      seedFromMessage(`Gateway sync error: ${message}`)
    } finally {
      syncInFlight = false
      scheduleNextSync()
    }
  }

  const scheduleReconnect = (): void => {
    if (disposed) return
    clearReconnectTimer()
    reconnectTimer = window.setTimeout(() => {
      openSocket()
    }, reconnectDelay)
    reconnectDelay = Math.min(GATEWAY_RECONNECT_MAX_MS, Math.floor(reconnectDelay * 1.7))
  }

  const requestConnect = (): void => {
    if (disposed || connectInFlight || !socket || socket.readyState !== WebSocket.OPEN) return
    connectInFlight = true

    void requestGateway('connect', {
      minProtocol: 3,
      maxProtocol: 3,
      client: {
        id: 'webchat-ui',
        version: 'pixel-agents-web',
        platform: navigator.platform || 'web',
        mode: 'webchat',
        instanceId: `pixel-agents-${createRequestId()}`,
      },
      role: 'operator',
      scopes: ['operator.admin', 'operator.approvals', 'operator.pairing'],
      caps: [],
      auth: settings.token || settings.password
        ? {
            token: settings.token,
            password: settings.password,
          }
        : undefined,
      userAgent: navigator.userAgent,
      locale: navigator.language,
    })
      .then(() => {
        reconnectDelay = GATEWAY_RECONNECT_BASE_MS
        void syncNow()
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        seedFromMessage(`Gateway connect failed: ${message}`)
        try {
          socket?.close()
        } catch {
          // Ignore close errors.
        }
      })
      .finally(() => {
        connectInFlight = false
      })
  }

  const scheduleConnectHandshake = (): void => {
    connectInFlight = false
    clearConnectDelayTimer()
    connectDelayTimer = window.setTimeout(() => {
      requestConnect()
    }, GATEWAY_CONNECT_DELAY_MS)
  }

  const handleSocketMessage = (raw: unknown): void => {
    let parsed: unknown = null
    try {
      parsed = JSON.parse(String(raw))
    } catch {
      return
    }
    if (!isRecord(parsed) || !('type' in parsed)) return

    if (parsed.type === 'event') {
      const eventName = asNonEmptyString(parsed.event)
      if (eventName === 'connect.challenge') {
        requestConnect()
        return
      }
      if (eventName === 'agent' || eventName === 'cron' || eventName === 'chat') {
        void syncNow()
      }
      return
    }

    if (parsed.type === 'res') {
      const responseId = asNonEmptyString(parsed.id)
      if (!responseId) return
      const request = pending.get(responseId)
      if (!request) return

      pending.delete(responseId)
      window.clearTimeout(request.timer)
      if (parsed.ok) {
        request.resolve(parsed.payload)
      } else {
        const errorMessage =
          isRecord(parsed.error) && asNonEmptyString(parsed.error.message)
            ? asNonEmptyString(parsed.error.message)
            : 'gateway request failed'
        request.reject(new Error(errorMessage))
      }
    }
  }

  const openSocket = (): void => {
    if (disposed) return

    clearConnectDelayTimer()
    clearPollTimer()

    try {
      socket = new WebSocket(settings.url)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      seedFromMessage(`Invalid gateway URL: ${message}`)
      scheduleReconnect()
      return
    }

    socket.addEventListener('open', () => {
      scheduleConnectHandshake()
    })

    socket.addEventListener('message', (event) => {
      handleSocketMessage(event.data)
    })

    socket.addEventListener('close', () => {
      clearConnectDelayTimer()
      clearPollTimer()
      rejectAllPending('gateway disconnected')
      seedFromMessage('Gateway disconnected — retrying…')
      scheduleReconnect()
    })

    socket.addEventListener('error', () => {
      seedFromMessage('Gateway transport error')
    })
  }

  seedFromMessage('Connecting to OpenClaw gateway…')
  openSocket()

  return () => {
    disposed = true
    clearConnectDelayTimer()
    clearPollTimer()
    clearReconnectTimer()
    rejectAllPending('browser telemetry stopped')
    try {
      socket?.close()
    } catch {
      // Ignore close errors during disposal.
    }
    socket = null
  }
}

function saveAgentSeats(os: OfficeState): void {
  const seats: Record<number, { palette: number; hueShift: number; seatId: string | null }> = {}
  for (const ch of os.characters.values()) {
    if (ch.isSubagent) continue
    seats[ch.id] = { palette: ch.palette, hueShift: ch.hueShift, seatId: ch.seatId }
  }
  vscode.postMessage({ type: 'saveAgentSeats', seats })
}

export function useExtensionMessages(
  getOfficeState: () => OfficeState,
  onLayoutLoaded?: (layout: OfficeLayout) => void,
  isEditDirty?: () => boolean,
): ExtensionMessageState {
  const [agents, setAgents] = useState<number[]>([])
  const [selectedAgent, setSelectedAgent] = useState<number | null>(null)
  const [agentTools, setAgentTools] = useState<Record<number, ToolActivity[]>>({})
  const [agentStatuses, setAgentStatuses] = useState<Record<number, string>>({})
  const [subagentTools, setSubagentTools] = useState<Record<number, Record<string, ToolActivity[]>>>({})
  const [subagentCharacters, setSubagentCharacters] = useState<SubagentCharacter[]>([])
  const [layoutReady, setLayoutReady] = useState(false)
  const [loadedAssets, setLoadedAssets] = useState<{ catalog: FurnitureAsset[]; sprites: Record<string, string[][]> } | undefined>()
  const [workspaceFolders, setWorkspaceFolders] = useState<WorkspaceFolder[]>([])

  // Track whether initial layout has been loaded (ref to avoid re-render)
  const layoutReadyRef = useRef(false)

  useEffect(() => {
    // Buffer agents from existingAgents until layout is loaded
    let pendingAgents: Array<{ id: number; palette?: number; hueShift?: number; seatId?: string; folderName?: string }> = []

    const handler = (e: MessageEvent) => {
      const msg = e.data
      const os = getOfficeState()

      if (msg.type === 'layoutLoaded') {
        // Skip external layout updates while editor has unsaved changes
        if (layoutReadyRef.current && isEditDirty?.()) {
          console.log('[Webview] Skipping external layout update — editor has unsaved changes')
          return
        }
        const rawLayout = msg.layout as OfficeLayout | null
        const layout = rawLayout && rawLayout.version === 1 ? migrateLayoutColors(rawLayout) : null
        if (layout) {
          os.rebuildFromLayout(layout)
          onLayoutLoaded?.(layout)
        } else {
          // Default layout — snapshot whatever OfficeState built
          onLayoutLoaded?.(os.getLayout())
        }
        // Add buffered agents now that layout (and seats) are correct
        for (const p of pendingAgents) {
          os.addAgent(p.id, p.palette, p.hueShift, p.seatId, true, p.folderName)
        }
        pendingAgents = []
        layoutReadyRef.current = true
        setLayoutReady(true)
        if (os.characters.size > 0) {
          saveAgentSeats(os)
        }
      } else if (msg.type === 'agentCreated') {
        const id = msg.id as number
        const folderName = msg.folderName as string | undefined
        setAgents((prev) => (prev.includes(id) ? prev : [...prev, id]))
        setSelectedAgent(id)
        os.addAgent(id, undefined, undefined, undefined, undefined, folderName)
        saveAgentSeats(os)
      } else if (msg.type === 'agentClosed') {
        const id = msg.id as number
        setAgents((prev) => prev.filter((a) => a !== id))
        setSelectedAgent((prev) => (prev === id ? null : prev))
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setAgentStatuses((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.removeAgent(id)
      } else if (msg.type === 'existingAgents') {
        const incoming = msg.agents as number[]
        const meta = (msg.agentMeta || {}) as Record<number, { palette?: number; hueShift?: number; seatId?: string }>
        const folderNames = (msg.folderNames || {}) as Record<number, string>
        // Buffer agents — they'll be added in layoutLoaded after seats are built
        for (const id of incoming) {
          const m = meta[id]
          pendingAgents.push({ id, palette: m?.palette, hueShift: m?.hueShift, seatId: m?.seatId, folderName: folderNames[id] })
        }
        setAgents((prev) => {
          const ids = new Set(prev)
          const merged = [...prev]
          for (const id of incoming) {
            if (!ids.has(id)) {
              merged.push(id)
            }
          }
          return merged.sort((a, b) => a - b)
        })
      } else if (msg.type === 'agentToolStart') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        const status = msg.status as string
        setAgentTools((prev) => {
          const list = prev[id] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: [...list, { toolId, status, done: false }] }
        })
        const toolName = extractToolName(status)
        os.setAgentTool(id, toolName)
        os.setAgentActive(id, true)
        os.clearPermissionBubble(id)
        // Create sub-agent character for Task tool subtasks
        if (status.startsWith('Subtask:')) {
          const label = status.slice('Subtask:'.length).trim()
          const subId = os.addSubagent(id, toolId)
          setSubagentCharacters((prev) => {
            if (prev.some((s) => s.id === subId)) return prev
            return [...prev, { id: subId, parentAgentId: id, parentToolId: toolId, label }]
          })
        }
      } else if (msg.type === 'agentToolDone') {
        const id = msg.id as number
        const toolId = msg.toolId as string
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)),
          }
        })
      } else if (msg.type === 'agentToolsClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        setSubagentTools((prev) => {
          if (!(id in prev)) return prev
          const next = { ...prev }
          delete next[id]
          return next
        })
        // Remove all sub-agent characters belonging to this agent
        os.removeAllSubagents(id)
        setSubagentCharacters((prev) => prev.filter((s) => s.parentAgentId !== id))
        os.setAgentTool(id, null)
        os.clearPermissionBubble(id)
      } else if (msg.type === 'agentSelected') {
        const id = msg.id as number
        setSelectedAgent(id)
      } else if (msg.type === 'agentStatus') {
        const id = msg.id as number
        const status = msg.status as string
        setAgentStatuses((prev) => {
          if (status === 'active') {
            if (!(id in prev)) return prev
            const next = { ...prev }
            delete next[id]
            return next
          }
          return { ...prev, [id]: status }
        })
        os.setAgentActive(id, status === 'active')
        if (status === 'waiting') {
          os.showWaitingBubble(id)
          playDoneSound()
        }
      } else if (msg.type === 'agentToolPermission') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.done ? t : { ...t, permissionWait: true })),
          }
        })
        os.showPermissionBubble(id)
      } else if (msg.type === 'subagentToolPermission') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        // Show permission bubble on the sub-agent character
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          os.showPermissionBubble(subId)
        }
      } else if (msg.type === 'agentToolPermissionClear') {
        const id = msg.id as number
        setAgentTools((prev) => {
          const list = prev[id]
          if (!list) return prev
          const hasPermission = list.some((t) => t.permissionWait)
          if (!hasPermission) return prev
          return {
            ...prev,
            [id]: list.map((t) => (t.permissionWait ? { ...t, permissionWait: false } : t)),
          }
        })
        os.clearPermissionBubble(id)
        // Also clear permission bubbles on all sub-agent characters of this parent
        for (const [subId, meta] of os.subagentMeta) {
          if (meta.parentAgentId === id) {
            os.clearPermissionBubble(subId)
          }
        }
      } else if (msg.type === 'subagentToolStart') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        const status = msg.status as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id] || {}
          const list = agentSubs[parentToolId] || []
          if (list.some((t) => t.toolId === toolId)) return prev
          return { ...prev, [id]: { ...agentSubs, [parentToolId]: [...list, { toolId, status, done: false }] } }
        })
        // Update sub-agent character's tool and active state
        const subId = os.getSubagentId(id, parentToolId)
        if (subId !== null) {
          const subToolName = extractToolName(status)
          os.setAgentTool(subId, subToolName)
          os.setAgentActive(subId, true)
        }
      } else if (msg.type === 'subagentToolDone') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        const toolId = msg.toolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs) return prev
          const list = agentSubs[parentToolId]
          if (!list) return prev
          return {
            ...prev,
            [id]: { ...agentSubs, [parentToolId]: list.map((t) => (t.toolId === toolId ? { ...t, done: true } : t)) },
          }
        })
      } else if (msg.type === 'subagentClear') {
        const id = msg.id as number
        const parentToolId = msg.parentToolId as string
        setSubagentTools((prev) => {
          const agentSubs = prev[id]
          if (!agentSubs || !(parentToolId in agentSubs)) return prev
          const next = { ...agentSubs }
          delete next[parentToolId]
          if (Object.keys(next).length === 0) {
            const outer = { ...prev }
            delete outer[id]
            return outer
          }
          return { ...prev, [id]: next }
        })
        // Remove sub-agent character
        os.removeSubagent(id, parentToolId)
        setSubagentCharacters((prev) => prev.filter((s) => !(s.parentAgentId === id && s.parentToolId === parentToolId)))
      } else if (msg.type === 'characterSpritesLoaded') {
        const characters = msg.characters as Array<{ down: string[][][]; up: string[][][]; right: string[][][] }>
        console.log(`[Webview] Received ${characters.length} pre-colored character sprites`)
        setCharacterTemplates(characters)
      } else if (msg.type === 'floorTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} floor tile patterns`)
        setFloorSprites(sprites)
      } else if (msg.type === 'wallTilesLoaded') {
        const sprites = msg.sprites as string[][][]
        console.log(`[Webview] Received ${sprites.length} wall tile sprites`)
        setWallSprites(sprites)
      } else if (msg.type === 'workspaceFolders') {
        const folders = msg.folders as WorkspaceFolder[]
        setWorkspaceFolders(folders)
      } else if (msg.type === 'settingsLoaded') {
        const soundOn = msg.soundEnabled as boolean
        setSoundEnabled(soundOn)
      } else if (msg.type === 'furnitureAssetsLoaded') {
        try {
          const catalog = msg.catalog as FurnitureAsset[]
          const sprites = msg.sprites as Record<string, string[][]>
          console.log(`📦 Webview: Loaded ${catalog.length} furniture assets`)
          // Build dynamic catalog immediately so getCatalogEntry() works when layoutLoaded arrives next
          buildDynamicCatalog({ catalog, sprites })
          setLoadedAssets({ catalog, sprites })
        } catch (err) {
          console.error(`❌ Webview: Error processing furnitureAssetsLoaded:`, err)
        }
      }
    }

    let stopBrowserTelemetry: (() => void) | undefined

    window.addEventListener('message', handler)
    vscode.postMessage({ type: 'webviewReady' })

    if (!IS_VSCODE_API_AVAILABLE && !layoutReadyRef.current) {
      const os = getOfficeState()
      onLayoutLoaded?.(os.getLayout())
      layoutReadyRef.current = true
      setLayoutReady(true)
      setSubagentTools({})
      setSubagentCharacters([])

      stopBrowserTelemetry = startBrowserTelemetry({
        officeState: os,
        setAgents,
        setSelectedAgent,
        setAgentTools,
        setAgentStatuses,
      })
    }

    return () => {
      window.removeEventListener('message', handler)
      stopBrowserTelemetry?.()
    }
  }, [getOfficeState])

  return { agents, selectedAgent, agentTools, agentStatuses, subagentTools, subagentCharacters, layoutReady, loadedAssets, workspaceFolders }
}
