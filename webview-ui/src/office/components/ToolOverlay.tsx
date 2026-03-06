import { useState, useEffect } from 'react'
import type { ToolActivity } from '../types.js'
import type { OfficeState } from '../engine/officeState.js'
import type { SubagentCharacter } from '../../hooks/useExtensionMessages.js'
import { TILE_SIZE, CharacterState } from '../types.js'
import { TOOL_OVERLAY_VERTICAL_OFFSET, CHARACTER_SITTING_OFFSET_PX } from '../../constants.js'

interface ToolOverlayProps {
  officeState: OfficeState
  agents: number[]
  agentTools: Record<number, ToolActivity[]>
  agentStatuses: Record<number, string>
  subagentCharacters: SubagentCharacter[]
  containerRef: React.RefObject<HTMLDivElement | null>
  zoom: number
  panRef: React.RefObject<{ x: number; y: number }>
  onCloseAgent: (id: number) => void
}

function humanizeStatus(status: string | undefined): string | undefined {
  if (!status || status === 'active') return undefined
  if (status === 'waiting') return 'Awaiting input or approval'
  if (/gateway disconnected/i.test(status)) return 'Gateway disconnected, retrying now'
  if (/connecting/i.test(status)) return 'Connecting to OpenClaw gateway'
  if (/transport error/i.test(status)) return 'Gateway transport error detected'
  return status
}

function getMainAgentSynopsis(
  agentId: number,
  folderName: string | undefined,
  isActive: boolean,
  agentTools: Record<number, ToolActivity[]>,
  agentStatuses: Record<number, string>,
): string[] {
  const tools = agentTools[agentId] || []
  const status = agentStatuses[agentId]
  const activeTool = [...tools].reverse().find((tool) => !tool.done)
  const pendingCount = tools.filter((tool) => !tool.done).length
  const doneCount = tools.filter((tool) => tool.done).length

  const bullets: string[] = []

  if (activeTool) {
    bullets.push(activeTool.permissionWait ? 'Waiting for approval before next action' : activeTool.status)
  } else {
    const normalizedStatus = humanizeStatus(status)
    if (normalizedStatus) {
      bullets.push(normalizedStatus)
    }
  }

  if (pendingCount > 1) {
    bullets.push(`Working through ${pendingCount} active items`)
  } else if (doneCount > 0) {
    bullets.push(`${doneCount} recent task${doneCount === 1 ? '' : 's'} completed`)
  } else if (isActive) {
    bullets.push('Seated at desk and ready for incoming work')
  } else {
    bullets.push('Idle roam mode while monitoring for new tasks')
  }

  if (folderName) {
    bullets.push(`Workspace: ${folderName}`)
  } else if (isActive) {
    bullets.push('Desk systems online')
  } else {
    bullets.push('Patrolling shared office')
  }

  return bullets.slice(0, 3)
}

function getSubagentSynopsis(
  sub: SubagentCharacter | undefined,
  folderName: string | undefined,
): string[] {
  const bullets: string[] = []
  bullets.push(sub?.label ? `Subtask: ${sub.label}` : 'Subtask worker active')
  bullets.push(sub ? `Supporting Agent #${sub.parentAgentId}` : 'Supporting parent workflow')
  bullets.push(folderName ? `Workspace: ${folderName}` : 'Coordinating in shared office')
  return bullets.slice(0, 3)
}

export function ToolOverlay({
  officeState,
  agents,
  agentTools,
  agentStatuses,
  subagentCharacters,
  containerRef,
  zoom,
  panRef,
  onCloseAgent,
}: ToolOverlayProps) {
  const [, setTick] = useState(0)
  useEffect(() => {
    let rafId = 0
    const tick = () => {
      setTick((n) => n + 1)
      rafId = requestAnimationFrame(tick)
    }
    rafId = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(rafId)
  }, [])

  const el = containerRef.current
  if (!el) return null
  const rect = el.getBoundingClientRect()
  const dpr = window.devicePixelRatio || 1
  const canvasW = Math.round(rect.width * dpr)
  const canvasH = Math.round(rect.height * dpr)
  const layout = officeState.getLayout()
  const mapW = layout.cols * TILE_SIZE * zoom
  const mapH = layout.rows * TILE_SIZE * zoom
  const deviceOffsetX = Math.floor((canvasW - mapW) / 2) + Math.round(panRef.current.x)
  const deviceOffsetY = Math.floor((canvasH - mapH) / 2) + Math.round(panRef.current.y)

  const selectedId = officeState.selectedAgentId
  const hoveredId = officeState.hoveredAgentId

  // All character IDs
  const allIds = [...agents, ...subagentCharacters.map((s) => s.id)]

  return (
    <>
      {allIds.map((id) => {
        const ch = officeState.characters.get(id)
        if (!ch) return null

        const isSelected = selectedId === id
        const isHovered = hoveredId === id
        const isSub = ch.isSubagent

        // Only show for hovered or selected agents
        if (!isSelected && !isHovered) return null

        // Position above character
        const sittingOffset = ch.state === CharacterState.TYPE ? CHARACTER_SITTING_OFFSET_PX : 0
        const screenX = (deviceOffsetX + ch.x * zoom) / dpr
        const screenY = (deviceOffsetY + (ch.y + sittingOffset - TOOL_OVERLAY_VERTICAL_OFFSET) * zoom) / dpr

        // Build heading and synopsis bullets
        const sub = isSub ? subagentCharacters.find((entry) => entry.id === id) : undefined
        const title = isSub ? 'Subtask Support' : `Agent #${id}`

        const subHasPermission = isSub && ch.bubbleType === 'permission'
        const synopsis = isSub
          ? getSubagentSynopsis(sub, ch.folderName)
          : getMainAgentSynopsis(id, ch.folderName, ch.isActive, agentTools, agentStatuses)

        // Determine dot color
        const tools = agentTools[id]
        const hasPermission = subHasPermission || tools?.some((tool) => tool.permissionWait && !tool.done)
        const hasActiveTools = tools?.some((t) => !t.done)
        const isActive = ch.isActive
        const status = !isSub ? agentStatuses[id] : undefined
        const hasGatewayIssue = !!status && status !== 'waiting' && /gateway|connect|transport|error/i.test(status)

        let dotColor: string | null = null
        if (hasPermission) {
          dotColor = 'var(--pixel-status-permission)'
        } else if (hasGatewayIssue) {
          dotColor = 'var(--pixel-status-error)'
        } else if (status === 'waiting') {
          dotColor = 'var(--pixel-status-waiting)'
        } else if (isActive && hasActiveTools) {
          dotColor = 'var(--pixel-status-active)'
        }

        return (
          <div
            key={id}
            style={{
              position: 'absolute',
              left: screenX,
              top: screenY - 24,
              transform: 'translateX(-50%)',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              pointerEvents: isSelected ? 'auto' : 'none',
              zIndex: isSelected ? 'var(--pixel-overlay-selected-z)' : 'var(--pixel-overlay-z)',
            }}
          >
            <div
              style={{
                display: 'flex',
                alignItems: 'flex-start',
                gap: 6,
                background: 'var(--pixel-bg)',
                border: isSelected
                  ? '2px solid var(--pixel-border-light)'
                  : '2px solid var(--pixel-border)',
                borderRadius: 0,
                padding: isSelected ? '4px 6px 4px 8px' : '4px 8px',
                boxShadow: 'var(--pixel-shadow)',
                maxWidth: 320,
              }}
            >
              {dotColor && (
                <span
                    className={isActive && !hasPermission && !hasGatewayIssue ? 'pixel-agents-pulse' : undefined}
                  style={{
                    width: 6,
                    height: 6,
                    borderRadius: '50%',
                    background: dotColor,
                    flexShrink: 0,
                      marginTop: 6,
                  }}
                />
              )}
                <div style={{ overflow: 'hidden', minWidth: 0 }}>
                <span
                  style={{
                      fontSize: '20px',
                      fontStyle: isSub ? 'italic' : undefined,
                    color: 'var(--vscode-foreground)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    display: 'block',
                      marginBottom: 1,
                  }}
                >
                    {title}
                </span>
                  {synopsis.map((line, index) => (
                  <span
                      key={`${id}-synopsis-${index}`}
                    style={{
                        fontSize: '16px',
                      color: 'var(--pixel-text-dim)',
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      display: 'block',
                        whiteSpace: 'nowrap',
                    }}
                  >
                      • {line}
                  </span>
                  ))}
              </div>
              {isSelected && !isSub && (
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    onCloseAgent(id)
                  }}
                  title="Close agent"
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--pixel-close-text)',
                    cursor: 'pointer',
                    padding: '0 2px',
                    fontSize: '24px',
                    lineHeight: 1,
                    marginLeft: 2,
                    flexShrink: 0,
                  }}
                  onMouseEnter={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-hover)'
                  }}
                  onMouseLeave={(e) => {
                    (e.currentTarget as HTMLElement).style.color = 'var(--pixel-close-text)'
                  }}
                >
                  ×
                </button>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}
