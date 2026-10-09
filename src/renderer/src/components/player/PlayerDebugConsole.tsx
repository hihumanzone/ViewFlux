import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { LogSubsystem, PlaybackLogEntry } from '../../../../shared/types'
import { Icon } from '../Icons'
import { formatLogsForClipboard } from './usePlayerDebugLogs'

export interface PlayerDebugConsoleProps {
  logs: PlaybackLogEntry[]
  onClear: () => void
  onClose: () => void
}

type FilterCategory = 'ALL' | 'ERRORS' | 'NETWORK' | 'RECOVERY' | 'SHAKA'

export function PlayerDebugConsole({
  logs,
  onClear,
  onClose
}: PlayerDebugConsoleProps): React.JSX.Element {
  const [filter, setFilter] = useState<FilterCategory>('ALL')
  const [autoScroll, setAutoScroll] = useState(true)
  const [expandedLogIds, setExpandedLogIds] = useState<Set<string>>(new Set())
  const [copied, setCopied] = useState(false)
  const logContainerRef = useRef<HTMLDivElement | null>(null)

  const filteredLogs = useMemo(() => {
    switch (filter) {
      case 'ERRORS':
        return logs.filter(
          (l) => l.level.toLowerCase() === 'error' || l.level.toLowerCase() === 'warn' || l.rawError
        )
      case 'NETWORK':
        return logs.filter((l) => l.subsystem === 'PROXY' || l.subsystem === 'MANIFEST')
      case 'RECOVERY':
        return logs.filter((l) => l.subsystem === 'RECOVERY' || l.subsystem === 'WATCHDOG')
      case 'SHAKA':
        return logs.filter((l) => l.subsystem === 'SHAKA' || l.subsystem === 'MEDIA')
      default:
        return logs
    }
  }, [logs, filter])

  // Auto-scroll to bottom when new logs arrive if auto-scroll is enabled
  useEffect(() => {
    if (!autoScroll || !logContainerRef.current) return
    logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight
  }, [filteredLogs, autoScroll])

  const toggleExpand = (id: string): void => {
    setExpandedLogIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const handleCopy = async (): Promise<void> => {
    const text = formatLogsForClipboard(filteredLogs)
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 2000)
    } catch (err) {
      console.error('Failed to copy logs to clipboard:', err)
    }
  }

  const formatTimestamp = (timestamp: number, isoTime: string): string => {
    try {
      const d = new Date(timestamp)
      const h = String(d.getHours()).padStart(2, '0')
      const m = String(d.getMinutes()).padStart(2, '0')
      const s = String(d.getSeconds()).padStart(2, '0')
      const ms = String(d.getMilliseconds()).padStart(3, '0')
      return `${h}:${m}:${s}.${ms}`
    } catch {
      return isoTime.slice(11, 23)
    }
  }

  const getSubsystemColor = (subsystem: LogSubsystem): string => {
    switch (subsystem) {
      case 'SHAKA':
        return '#38bdf8' // sky-400
      case 'PROXY':
        return '#a855f7' // purple-500
      case 'MANIFEST':
        return '#ec4899' // pink-500
      case 'WATCHDOG':
        return '#f97316' // orange-500
      case 'MEDIA':
        return '#10b981' // emerald-500
      case 'RECOVERY':
        return '#eab308' // yellow-500
      default:
        return '#94a3b8'
    }
  }

  const getLevelBadgeClass = (level: string): string => {
    const l = level.toLowerCase()
    if (l === 'error') return 'player__debug-badge--error'
    if (l === 'warn') return 'player__debug-badge--warn'
    if (l === 'debug') return 'player__debug-badge--debug'
    return 'player__debug-badge--info'
  }

  return (
    <div
      className="player__debug-console"
      role="region"
      aria-label="Player Technical Debug Console"
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header */}
      <div className="player__debug-header">
        <div className="player__debug-title-group">
          <span className="player__debug-live-dot" title="Live stream capture active" />
          <Icon name="terminal" size={16} className="player__debug-icon" />
          <span className="player__debug-title">PLAYBACK DEBUG CONSOLE</span>
          <span className="player__debug-counter">
            {filteredLogs.length} / {logs.length} events
          </span>
        </div>

        {/* Filter chips */}
        <div className="player__debug-filters">
          {(['ALL', 'ERRORS', 'NETWORK', 'RECOVERY', 'SHAKA'] as const).map((cat) => (
            <button
              key={cat}
              type="button"
              className={`player__debug-chip ${filter === cat ? 'player__debug-chip--active' : ''}`}
              onClick={() => setFilter(cat)}
            >
              {cat}
            </button>
          ))}
        </div>

        {/* Actions */}
        <div className="player__debug-actions">
          <button
            type="button"
            className={`player__debug-btn ${autoScroll ? 'player__debug-btn--active' : ''}`}
            onClick={() => setAutoScroll((v) => !v)}
            title={autoScroll ? 'Auto-scroll: ON' : 'Auto-scroll: PAUSED'}
          >
            {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </button>
          <button
            type="button"
            className="player__debug-btn"
            onClick={handleCopy}
            title="Copy logs to clipboard"
          >
            <Icon name="copy" size={14} />
            {copied ? 'Copied!' : 'Copy'}
          </button>
          <button
            type="button"
            className="player__debug-btn"
            onClick={onClear}
            title="Clear in-memory debug logs"
          >
            <Icon name="delete" size={14} />
            Clear
          </button>
          <button
            type="button"
            className="player__debug-btn player__debug-btn--close"
            onClick={onClose}
            title="Close console (D)"
            aria-label="Close debug console"
          >
            <Icon name="close" size={16} />
          </button>
        </div>
      </div>

      {/* Log list */}
      <div className="player__debug-body" ref={logContainerRef}>
        {filteredLogs.length === 0 ? (
          <div className="player__debug-empty">
            <span className="player__debug-empty-text">No debug logs match the active filter.</span>
          </div>
        ) : (
          filteredLogs.map((entry) => {
            const isExpanded = expandedLogIds.has(entry.id)
            const hasDetails = Boolean(
              entry.trigger || entry.nextStep || entry.rawError || entry.data
            )
            const timeStr = formatTimestamp(entry.timestamp, entry.isoTime)

            return (
              <div
                key={entry.id}
                className={`player__debug-row ${hasDetails ? 'player__debug-row--clickable' : ''} ${
                  isExpanded ? 'player__debug-row--expanded' : ''
                }`}
                onClick={() => hasDetails && toggleExpand(entry.id)}
              >
                <div className="player__debug-line">
                  <span className="player__debug-timestamp">{timeStr}</span>
                  <span className={`player__debug-badge ${getLevelBadgeClass(entry.level)}`}>
                    {entry.level.toUpperCase()}
                  </span>
                  <span
                    className="player__debug-subsystem"
                    style={{ color: getSubsystemColor(entry.subsystem) }}
                  >
                    [{entry.subsystem}]
                  </span>
                  <span className="player__debug-action">{entry.action}:</span>
                  <span className="player__debug-msg">{entry.message}</span>
                  {hasDetails && (
                    <span className="player__debug-expand-hint" title="Toggle technical details">
                      <Icon name={isExpanded ? 'up' : 'down'} size={12} />
                    </span>
                  )}
                </div>

                {/* Technical drill-down */}
                {isExpanded && (
                  <div
                    className="player__debug-details"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {entry.trigger && (
                      <div className="player__debug-field">
                        <span className="player__debug-label">TRIGGER:</span>
                        <span className="player__debug-val player__debug-val--trigger">
                          {entry.trigger}
                        </span>
                      </div>
                    )}
                    {entry.nextStep && (
                      <div className="player__debug-field">
                        <span className="player__debug-label">NEXT STEP:</span>
                        <span className="player__debug-val player__debug-val--next">
                          {entry.nextStep}
                        </span>
                      </div>
                    )}
                    {entry.rawError && (
                      <div className="player__debug-field player__debug-field--error">
                        <span className="player__debug-label">RAW ERROR:</span>
                        <pre className="player__debug-val player__debug-pre player__debug-val--error">
                          {entry.rawError}
                        </pre>
                      </div>
                    )}
                    {entry.data && (
                      <div className="player__debug-field">
                        <span className="player__debug-label">PAYLOAD DATA:</span>
                        <pre className="player__debug-val player__debug-pre">
                          {JSON.stringify(entry.data, null, 2)}
                        </pre>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
