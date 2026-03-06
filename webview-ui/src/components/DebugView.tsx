import type { ToolActivity } from '../office/types.js'
import { vscode } from '../vscodeApi.js'

interface DebugViewProps {
  agents: number[]
  selectedAgent: number | null
  agentNames: Record<number, string>
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentTools: Record<number, Record<string, ToolActivity[]>>
  onSelectAgent: (id: number) => void
}

/** Z-index just below the floating toolbar (50) so the toolbar stays on top */
const DEBUG_Z = 40

function normalizeToolStatus(status: string): string {
  if (/(gateway disconnected|gateway transport error|gateway connect failed|gateway sync error|connecting to openclaw gateway)/i.test(status)) {
    return 'Autonomous loop running while telemetry syncs'
  }
  return status
}

function humanizeStatus(status: string | undefined): string | undefined {
  if (!status || status === 'active') return undefined
  if (status === 'waiting') return 'Awaiting input or approval'
  if (status === 'autonomous-idle') return 'Autonomous idle patrol with proactive checks'
  if (status === 'telemetry-sync') return 'Autonomous loop running while telemetry syncs'
  if (/(gateway|transport|connect|sync)/i.test(status)) return 'Autonomous loop running while telemetry syncs'
  return status
}

function getAgentName(id: number, names: Record<number, string>): string {
  return names[id] || `Agent #${id}`
}

function getSynopsisLines(tools: ToolActivity[], status: string | undefined): string[] {
  const activeTool = [...tools].reverse().find((tool) => !tool.done)
  const activeCount = tools.filter((tool) => !tool.done).length
  const doneCount = tools.filter((tool) => tool.done).length
  const lines: string[] = []

  if (activeTool) {
    lines.push(activeTool.permissionWait ? 'Waiting for approval before next action' : normalizeToolStatus(activeTool.status))
  } else {
    lines.push(humanizeStatus(status) ?? 'Autonomous idle patrol with proactive checks')
  }

  if (activeCount > 1) {
    lines.push(`Working through ${activeCount} active items`)
  } else if (doneCount > 0) {
    lines.push(`${doneCount} recent task${doneCount === 1 ? '' : 's'} completed`)
  } else if (status === 'waiting') {
    lines.push('Queue monitoring enabled while awaiting approvals')
  } else {
    lines.push('No active tools; proactive standby remains engaged')
  }

  return lines.slice(0, 2)
}

function ToolDot({ tool }: { tool: ToolActivity }) {
  return (
    <span
      className={tool.done ? undefined : 'pixel-agents-pulse'}
      style={{
        width: 6,
        height: 6,
        borderRadius: '50%',
        background: tool.done
          ? 'var(--vscode-charts-green, #89d185)'
          : tool.permissionWait
            ? 'var(--vscode-charts-yellow, #cca700)'
            : 'var(--vscode-charts-blue, #3794ff)',
        display: 'inline-block',
        flexShrink: 0,
      }}
    />
  )
}

function ToolLine({ tool }: { tool: ToolActivity }) {
  return (
    <span
      style={{
        fontSize: '22px',
        opacity: tool.done ? 0.5 : 0.8,
        display: 'flex',
        alignItems: 'center',
        gap: 5,
      }}
    >
      <ToolDot tool={tool} />
      {tool.permissionWait && !tool.done ? 'Needs approval' : normalizeToolStatus(tool.status)}
    </span>
  )
}

export function DebugView({
  agents,
  selectedAgent,
  agentNames,
  agentTools,
  agentStatuses,
  subagentTools,
  onSelectAgent,
}: DebugViewProps) {
  const renderAgentCard = (id: number) => {
    const isSelected = selectedAgent === id
    const name = getAgentName(id, agentNames)
    const tools = agentTools[id] || []
    const subs = subagentTools[id] || {}
    const status = agentStatuses[id]
    const hasActiveTools = tools.some((t) => !t.done)
    const synopsis = getSynopsisLines(tools, status)

    return (
      <div
        key={id}
        style={{
          border: `2px solid ${isSelected ? '#5a8cff' : '#4a4a6a'}`,
          borderRadius: 0,
          padding: '6px 8px',
          background: isSelected ? 'var(--vscode-list-activeSelectionBackground, rgba(255,255,255,0.04))' : undefined,
        }}
      >
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0 }}>
          <button
            onClick={() => onSelectAgent(id)}
            style={{
              borderRadius: 0,
              padding: '6px 10px',
              fontSize: '26px',
              background: isSelected ? 'rgba(90, 140, 255, 0.25)' : undefined,
              color: isSelected ? '#fff' : undefined,
              fontWeight: isSelected ? 'bold' : undefined,
            }}
          >
            {name}
          </button>
          <span
            style={{
              fontSize: '18px',
              opacity: 0.7,
              padding: '0 8px 0 4px',
            }}
          >
            #{id}
          </span>
          <button
            onClick={() => vscode.postMessage({ type: 'closeAgent', id })}
            style={{
              borderRadius: 0,
              padding: '6px 8px',
              fontSize: '26px',
              opacity: 0.7,
              background: isSelected ? 'rgba(90, 140, 255, 0.25)' : undefined,
              color: isSelected ? '#fff' : undefined,
            }}
            title="Close agent"
          >
            ✕
          </button>
        </span>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 4, paddingLeft: 4 }}>
          {synopsis.map((line, index) => (
            <span
              key={`${id}-synopsis-${index}`}
              style={{
                fontSize: '20px',
                opacity: 0.85,
                display: 'flex',
                alignItems: 'center',
                gap: 5,
              }}
            >
              <span
                style={{
                  width: 6,
                  height: 6,
                  borderRadius: '50%',
                  background: index === 0 && hasActiveTools
                    ? 'var(--pixel-status-active)'
                    : status === 'waiting'
                      ? 'var(--pixel-status-waiting)'
                      : 'var(--vscode-descriptionForeground, rgba(255,255,255,0.4))',
                  display: 'inline-block',
                  flexShrink: 0,
                }}
              />
              {line}
            </span>
          ))}
        </div>

        {tools.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 1, marginTop: 4, paddingLeft: 4 }}>
            {tools.map((tool) => (
              <div key={tool.toolId}>
                <ToolLine tool={tool} />
                {subs[tool.toolId] && subs[tool.toolId].length > 0 && (
                  <div
                    style={{
                      borderLeft: '2px solid var(--vscode-widget-border, rgba(255,255,255,0.12))',
                      marginLeft: 3,
                      paddingLeft: 8,
                      marginTop: 1,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 1,
                    }}
                  >
                    {subs[tool.toolId].map((subTool) => (
                      <ToolLine key={subTool.toolId} tool={subTool} />
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    )
  }

  return (
    <div
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        background: 'var(--vscode-editor-background)',
        zIndex: DEBUG_Z,
        overflow: 'auto',
      }}
    >
      {/* Top padding so cards don't overlap the floating toolbar */}
      <div style={{ padding: '12px 12px 12px', fontSize: '28px' }}>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {agents.map(renderAgentCard)}
        </div>
      </div>
    </div>
  )
}
