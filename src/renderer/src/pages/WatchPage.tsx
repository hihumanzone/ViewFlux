import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Player, type PlayerHandle } from '../components/Player'
import { AddToPlaylistDialog } from '../components/AddToPlaylistDialog'
import { EmptyState, Loader, Spinner } from '../components/EmptyState'
import { Icon } from '../components/Icons'
import { navigate } from '../lib/router'
import { useApp } from '../state/AppContext'
import { formatCount, formatTime, formatRelative } from '../lib/format'
import { toPlaylistVideo } from '../lib/map'
import { useCopyLink, videoUrl } from '../lib/copyLink'
import { scrollPageToTop } from '../lib/scroll'
import { resolveYouTubeUrl } from '../lib/youtubeUrl'
import { useAsync } from '../lib/useAsync'
import { useBrokenImage } from '../lib/useBrokenImage'
import { readStoredWithLegacy, writeStored } from '../lib/storage'
import {
  getPlaylistSession,
  setPlaylistSpeed,
  setPlaylistVolume,
  setPlaylistCaptions,
  setPlaylistFullscreen
} from '../lib/playlistSession'
import { sponsorCategoryLabel, type RydResult, type Settings, type SponsorSegment, type VideoDetails } from '../../../shared/types'

interface QueueItem {
  videoId: string
  title: string
  author: string
  thumbnail: string
  duration: number | null
}

const REMOTE_PREFIX = 'yt:'
// Shared empty array so the SponsorBlock default does not change identity on
// every render, which would re-run the segments effect for no reason.
const NO_SEGMENTS: SponsorSegment[] = []

function renderDescriptionWithTimestamps(
  descText: string,
  onSeek: (seconds: number) => void
): React.ReactNode[] {
  if (!descText) return []
  const tokenRegex = /(https?:\/\/[^\s<>"'()]+|www\.[^\s<>"'()]+|\b(?:(?:\d{1,2}):)?\d{1,2}:\d{2}\b)/g
  const parts: React.ReactNode[] = []
  let lastIndex = 0
  let match: RegExpExecArray | null

  while ((match = tokenRegex.exec(descText)) !== null) {
    if (match.index > lastIndex) {
      parts.push(descText.substring(lastIndex, match.index))
    }
    const token = match[0]
    const matchIndex = match.index

    if (/^https?:\/\/|^www\./i.test(token)) {
      let cleanUrl = token
      let trailingPunct = ''
      const punctMatch = cleanUrl.match(/[.,;:!?)]+$/)
      if (punctMatch) {
        trailingPunct = punctMatch[0]
        cleanUrl = cleanUrl.slice(0, -trailingPunct.length)
      }
      const fullUrl = cleanUrl.startsWith('http') ? cleanUrl : `https://${cleanUrl}`
      const internalRoute = resolveYouTubeUrl(fullUrl)

      parts.push(
        <a
          key={`link-${matchIndex}`}
          href={fullUrl}
          className="watch__description-link"
          onClick={(e) => {
            e.preventDefault()
            e.stopPropagation()
            if (internalRoute) {
              navigate(internalRoute)
            } else {
              void window.api.openExternal(fullUrl)
            }
          }}
          title={internalRoute ? `Open in ViewFlux: ${fullUrl}` : `Open in browser: ${fullUrl}`}
        >
          {cleanUrl}
        </a>
      )
      if (trailingPunct) {
        parts.push(trailingPunct)
      }
    } else {
      const tsMatch = token.match(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/)
      if (tsMatch) {
        const hours = tsMatch[1] ? parseInt(tsMatch[1], 10) : 0
        const mins = parseInt(tsMatch[2], 10)
        const secs = parseInt(tsMatch[3], 10)
        const seconds = hours * 3600 + mins * 60 + secs

        parts.push(
          <button
            key={`ts-${matchIndex}`}
            type="button"
            className="watch__description-timestamp"
            onClick={(e) => {
              e.stopPropagation()
              onSeek(seconds)
              scrollPageToTop()
            }}
            title={`Jump to ${token}`}
          >
            {token}
          </button>
        )
      } else {
        parts.push(token)
      }
    }
    lastIndex = tokenRegex.lastIndex
  }

  if (lastIndex < descText.length) {
    parts.push(descText.substring(lastIndex))
  }

  return parts
}

interface MiniBounds {
  x: number
  y: number
  width: number
}

let memoryMiniBounds: MiniBounds | null = null
try {
  const saved = typeof localStorage !== 'undefined' ? localStorage.getItem('viewflux.miniplayer-bounds') : null
  if (saved) {
    const parsed = JSON.parse(saved)
    if (typeof parsed?.x === 'number' && typeof parsed?.y === 'number' && typeof parsed?.width === 'number') {
      memoryMiniBounds = parsed
    }
  }
} catch {
  // ignore
}

function saveMiniBounds(bounds: MiniBounds): void {
  memoryMiniBounds = bounds
  try {
    localStorage.setItem('viewflux.miniplayer-bounds', JSON.stringify(bounds))
  } catch {
    // ignore
  }
}

export function WatchPage({
  videoId,
  listId,
  initialSeek,
  isMini = false,
  onClose,
  onExpand,
  onAdvanceVideo
}: {
  videoId: string
  listId: string | null
  initialSeek?: number | null
  isMini?: boolean
  onClose?: () => void
  onExpand?: () => void
  onAdvanceVideo?: (nextVideoId: string) => void
}): React.JSX.Element | null {
  const { settings, playlists, refreshHistory, updateHistoryPosition, saveSettings, toast, getHistoryProgress } = useApp()
  const playerRef = useRef<PlayerHandle>(null)

  const playlistSession = getPlaylistSession(listId)
  const effectiveSpeed = playlistSession?.speed ?? settings.preferredSpeed
  const effectiveVolume = playlistSession?.volume ?? settings.defaultVolume
  const effectiveCaptions = playlistSession?.captionsEnabled ?? settings.alwaysShowCaptions

  // Memoised so the SponsorBlock request only refires when a category is
  // actually toggled, not on every unrelated settings write.
  const enabledCategories = useMemo(
    () =>
      settings.sponsorBlockEnabled
        ? Object.entries(settings.sponsorCategories)
            .filter(([, on]) => on)
            .map(([id]) => id)
        : [],
    [settings.sponsorBlockEnabled, settings.sponsorCategories]
  )

  const { data: details = null, error, loading } = useAsync<VideoDetails>(
    () => window.api.getVideo(videoId),
    [videoId]
  )
  // A live broadcast's presentation timeline is a sliding DVR window, so the
  // segments SponsorBlock reports for it (if any) refer to positions that are
  // already gone. Skip the request entirely rather than render a skip overlay
  // that can never fire.
  const isLive = details?.isLive ?? false
  const { data: segments = NO_SEGMENTS } = useAsync<SponsorSegment[]>(
    () => window.api.getSponsorSegments(videoId, enabledCategories),
    [videoId, enabledCategories],
    { enabled: enabledCategories.length > 0 && !isLive, keepPreviousData: true }
  )
  const { data: ryd = null } = useAsync<RydResult | null>(
    () => window.api.getDislikes(videoId),
    [videoId],
    { enabled: settings.showDislikes, keepPreviousData: true }
  )
  const { data: resume = (initialSeek && initialSeek > 0 ? initialSeek : 0), loading: resumeLoading, setData: setResume } = useAsync<number>(
    async () => {
      if (initialSeek != null && initialSeek > 0) {
        return initialSeek
      }
      const history = await window.api.getHistory()
      const entry = history.find((e) => e.videoId === videoId)
      if (!entry) return 0
      // If the video was completed (watched to within 5s of end or >=95% of duration), start from 0!
      const dur = entry.duration
      const isCompleted =
        (dur != null && dur > 0 && (entry.position >= dur - 5 || entry.position / dur >= 0.95)) ||
        entry.position <= 0.5
      return isCompleted ? 0 : entry.position
    },
    [videoId, initialSeek],
    // A history read that fails should not strand the player in "not ready";
    // falling back to 0 is what the screen would have shown anyway.
    { initialData: initialSeek && initialSeek > 0 ? initialSeek : 0 }
  )
  const ready = !resumeLoading
  const [descOpen, setDescOpen] = useState(false)
  // Only offer Show more / Show less when the text actually overflows.
  const [expandable, setExpandable] = useState(false)
  const descRef = useRef<HTMLDivElement>(null)
  const [addVideo, setAddVideo] = useState<ReturnType<typeof toPlaylistVideo> | null>(null)
  // The playlist sidebar gets its own collapse toggle, remembered across videos.
  const [queueCollapsed, setQueueCollapsed] = useState(
    () => readStoredWithLegacy('viewflux.queue', 'libretube.queue') === 'collapsed'
  )
  const toggleQueue = (): void => {
    setQueueCollapsed((prev) => {
      const next = !prev
      writeStored('viewflux.queue', next ? 'collapsed' : 'expanded')
      return next
    })
  }

  // Miniplayer draggable & resizable bounds state
  const [miniBounds, setMiniBounds] = useState<MiniBounds | null>(() => memoryMiniBounds)
  const miniElRef = useRef<HTMLDivElement>(null)
  const watchContainerRef = useRef<HTMLDivElement>(null)

  // Queue sidebar width state
  const [queueWidth, setQueueWidth] = useState<number>(() => {
    const stored = readStoredWithLegacy('viewflux.queue-w', 'libretube.queue-w')
    const val = stored ? parseInt(stored, 10) : 380
    return Number.isFinite(val) ? Math.max(220, Math.min(560, val)) : 380
  })

  // On window resize or orientation changes, keep miniplayer within bounds
  useEffect(() => {
    if (!isMini || !miniBounds) return
    const clampPosition = (): void => {
      const width = miniBounds.width || 380
      const height = width * (9 / 16)
      const margin = 16
      const minTop = 44
      const maxLeft = Math.max(margin, window.innerWidth - width - margin)
      const maxTop = Math.max(minTop, window.innerHeight - height - margin)

      setMiniBounds((prev) => {
        if (!prev) return null
        const clamped: MiniBounds = {
          x: Math.min(Math.max(margin, prev.x), maxLeft),
          y: Math.min(Math.max(minTop, prev.y), maxTop),
          width: Math.min(prev.width, window.innerWidth - margin * 2)
        }
        saveMiniBounds(clamped)
        return clamped
      })
    }

    window.addEventListener('resize', clampPosition)
    window.addEventListener('orientationchange', clampPosition)
    return () => {
      window.removeEventListener('resize', clampPosition)
      window.removeEventListener('orientationchange', clampPosition)
    }
  }, [isMini, miniBounds])

  const dragMovedRef = useRef(false)

  const handleMiniHeaderPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    const el = miniElRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    const startY = e.clientY
    const startLeft = rect.left
    const startTop = rect.top
    const width = rect.width
    const height = rect.height
    dragMovedRef.current = false

    const handlePointerMove = (moveEv: PointerEvent): void => {
      const dx = moveEv.clientX - startX
      const dy = moveEv.clientY - startY
      if (Math.abs(dx) > 4 || Math.abs(dy) > 4) {
        dragMovedRef.current = true
      }
      const margin = 16
      const minTop = 44
      const maxLeft = Math.max(margin, window.innerWidth - width - margin)
      const maxTop = Math.max(minTop, window.innerHeight - height - margin)

      const targetX = Math.min(Math.max(margin, startLeft + dx), maxLeft)
      const targetY = Math.min(Math.max(minTop, startTop + dy), maxTop)
      const bounds: MiniBounds = { x: targetX, y: targetY, width }
      setMiniBounds(bounds)
      saveMiniBounds(bounds)
    }

    const handlePointerUp = (): void => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      ;(document.activeElement as HTMLElement)?.blur()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [])

  const handleMiniResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.stopPropagation()
    const el = miniElRef.current
    if (!el) return

    const rect = el.getBoundingClientRect()
    const startX = e.clientX
    const startWidth = rect.width
    const startRight = rect.right
    const startBottom = rect.bottom

    const handlePointerMove = (moveEv: PointerEvent): void => {
      const dx = moveEv.clientX - startX
      const minW = 280
      const maxW = Math.min(window.innerWidth - 32, 860)
      const targetW = Math.max(minW, Math.min(maxW, startWidth - dx))
      const targetH = targetW * (9 / 16)

      let newLeft = startRight - targetW
      let newTop = startBottom - targetH

      if (newLeft < 16) newLeft = 16
      if (newTop < 44) newTop = 44

      const bounds: MiniBounds = {
        x: newLeft,
        y: newTop,
        width: targetW
      }
      setMiniBounds(bounds)
      saveMiniBounds(bounds)
    }

    const handlePointerUp = (): void => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)
      ;(document.activeElement as HTMLElement)?.blur()
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [])

  const handleQueueResizePointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return
    e.preventDefault()

    const aside = queueAsideRef.current
    const watchEl = watchContainerRef.current
    if (!aside || !watchEl) return

    const resizerEl = e.currentTarget
    try {
      resizerEl.setPointerCapture?.(e.pointerId)
    } catch {
      // ignore
    }

    const asideRect = aside.getBoundingClientRect()
    const asideRight = asideRect.right

    document.documentElement.dataset.resizing = 'true'
    watchEl.classList.add('watch--resizing')
    watchEl.classList.add('watch--resizing-active')

    let isCollapsed = queueCollapsed
    let currentWidth = queueWidth
    let reopenTimer: ReturnType<typeof setTimeout> | null = null
    let rafId = 0

    const minW = 220
    const collapseThreshold = 200

    const updateDOM = (nextCollapsed: boolean, nextW: number, isReopen: boolean): void => {
      const container = watchContainerRef.current
      const asideEl = queueAsideRef.current
      if (!container) return

      if (nextCollapsed) {
        // Drag to collapse: enable transition for smooth exit
        container.classList.remove('watch--resizing-active')
        container.classList.add('watch--queue-collapsed')
        container.classList.remove('watch--has-queue')
        asideEl?.classList.add('watch__side--collapsed')
      } else {
        // Drag to reopen or active resize
        container.style.setProperty('--queue-w', `${nextW}px`)
        container.classList.remove('watch--queue-collapsed')
        container.classList.add('watch--has-queue')
        asideEl?.classList.remove('watch__side--collapsed')

        if (isReopen) {
          // Play smooth reopen animation without transition suppression
          container.classList.remove('watch--resizing-active')
          if (reopenTimer) clearTimeout(reopenTimer)
          reopenTimer = setTimeout(() => {
            reopenTimer = null
            if (!isCollapsed && watchContainerRef.current) {
              watchContainerRef.current.classList.add('watch--resizing-active')
            }
          }, 320)
        } else if (!reopenTimer) {
          // Normal 1:1 active resize tracking
          container.classList.add('watch--resizing-active')
        }
      }
    }

    const handlePointerMove = (moveEv: PointerEvent): void => {
      const rawWidth = asideRight - moveEv.clientX
      const maxW = Math.min(560, Math.max(minW, window.innerWidth - 380))

      if (rawWidth < collapseThreshold) {
        if (!isCollapsed) {
          isCollapsed = true
          if (reopenTimer) {
            clearTimeout(reopenTimer)
            reopenTimer = null
          }
          if (rafId) cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(() => {
            rafId = 0
            updateDOM(true, currentWidth, false)
          })
        }
      } else {
        const targetW = Math.max(minW, Math.min(maxW, rawWidth))
        currentWidth = targetW

        if (isCollapsed) {
          isCollapsed = false
          if (rafId) cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(() => {
            rafId = 0
            updateDOM(false, targetW, true)
          })
        } else {
          if (rafId) cancelAnimationFrame(rafId)
          rafId = requestAnimationFrame(() => {
            rafId = 0
            updateDOM(false, targetW, false)
          })
        }
      }
    }

    const handlePointerUp = (upEv: PointerEvent): void => {
      if (rafId) cancelAnimationFrame(rafId)
      if (reopenTimer) clearTimeout(reopenTimer)

      try {
        if (resizerEl.hasPointerCapture?.(upEv.pointerId)) {
          resizerEl.releasePointerCapture?.(upEv.pointerId)
        }
      } catch {
        // ignore
      }

      delete document.documentElement.dataset.resizing
      watchContainerRef.current?.classList.remove('watch--resizing')
      watchContainerRef.current?.classList.remove('watch--resizing-active')

      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
      window.removeEventListener('pointercancel', handlePointerUp)

      setQueueCollapsed(isCollapsed)
      writeStored('viewflux.queue', isCollapsed ? 'collapsed' : 'expanded')

      if (!isCollapsed) {
        setQueueWidth(currentWidth)
        writeStored('viewflux.queue-w', String(currentWidth))
        watchContainerRef.current?.style.setProperty('--queue-w', `${currentWidth}px`)
      }
    }

    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
    window.addEventListener('pointercancel', handlePointerUp)
  }, [queueCollapsed, queueWidth])

  const handleExpand = useCallback(() => {
    if (dragMovedRef.current) {
      dragMovedRef.current = false
      return
    }
    onExpand?.()
  }, [onExpand])

  // Re-check resume once metadata details load with authoritative duration
  useEffect(() => {
    const dur = details?.duration
    if (!dur || dur <= 0) return
    if (initialSeek != null && initialSeek > 0) {
      if (initialSeek >= dur - 1) {
        setResume(0)
      }
      return
    }
    setResume((prev) => {
      const position = prev ?? 0
      if (position >= dur - 5 || position / dur >= 0.95) return 0
      return position
    })
  }, [details?.duration, initialSeek, setResume])

  // A fresh video starts with the description collapsed again.
  useEffect(() => {
    setDescOpen(false)
  }, [videoId])

  // ---- Is the description long enough to need Show more / Show less? ---------
  useEffect(() => {
    if (!details) return
    setDescOpen(false)
    let raf = 0
    let cancelled = false
    const measure = (): void => {
      const el = descRef.current
      if (!el || cancelled) return
      // Compare the full (unclamped) height against the 4-line clamp height.
      // This never depends on the clamp class being applied, so — unlike
      // measuring the clamped box — it cannot race with React's re-render.
      const cs = getComputedStyle(el)
      const fontSize = parseFloat(cs.fontSize) || 13.5
      let lineH = parseFloat(cs.lineHeight)
      if (!Number.isFinite(lineH)) lineH = fontSize * 1.6
      setExpandable(el.scrollHeight > lineH * 4 + 8)
    }
    const schedule = (): void => {
      // Double rAF lets layout (and usually webfonts) settle first.
      cancelAnimationFrame(raf)
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => measure())
      })
    }
    schedule()
    window.addEventListener('resize', schedule)
    // Font swaps change line wrapping; re-measure once they settle.
    if (typeof document !== 'undefined' && 'fonts' in document) {
      void document.fonts.ready.then(() => {
        if (!cancelled) measure()
      })
    }
    return () => {
      cancelled = true
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', schedule)
    }
  }, [details])

  // ---- Channel avatar (video info does not carry one) -------------------------
  // `details.authorThumbnail` is the fast path; only fall back to a channel
  // lookup when it is missing, and never let a lookup failure surface as an
  // error — the row simply shows the initial-letter avatar.
  const needsAvatar = details !== null && !details.authorThumbnail ? details.authorId : null
  const { data: avatarLookup } = useAsync<{ avatar: string | null; failed: boolean }>(
    async () => {
      try {
        return { avatar: (await window.api.getChannel(needsAvatar as string)).avatar, failed: false }
      } catch {
        return { avatar: null, failed: true }
      }
    },
    [needsAvatar],
    { enabled: needsAvatar !== null }
  )
  const authorAvatar = details?.authorThumbnail ?? avatarLookup?.avatar ?? null
  // `avatarLookup.failed` covers a failed *lookup*; `useBrokenImage` covers an
  // avatar URL that resolved but would not decode.
  const { broken: avatarBroken, onError: onAvatarError } = useBrokenImage(authorAvatar)
  const avatarFailed = (needsAvatar !== null && avatarLookup?.failed === true) || avatarBroken

  // ---- Record history once metadata is known ---------------------------------
  useEffect(() => {
    if (!details || !ready || !settings.saveWatchHistory) return
    void (async () => {
      await window.api.addHistory({
        videoId: details.videoId,
        title: details.title,
        author: details.author,
        thumbnail: details.thumbnails[0]?.url ?? '',
        duration: details.duration || null,
        position: resume,
        watchedAt: Date.now(),
        // Channel details are what History rows use for the avatar and the
        // clickable channel name; re-recording once the avatar lands fills them
        // in (the store keeps any value already stored).
        authorId: details.authorId,
        authorAvatar,
        viewCount: details.viewCount,
        published: details.relativeDate || details.publishDate,
        publishTimestamp: details.publishTimestamp,
        isPremiere: details.isPremiere,
        isStreamed: details.isStreamed,
        isLive: details.isLive
      })
      await refreshHistory()
    })()
  }, [details, ready, resume, authorAvatar, refreshHistory, settings.saveWatchHistory])

  // ---- Queue: local playlist or YouTube playlist ------------------------------
  // Two very different sources behind one `?list=` value: a `yt:` prefix means
  // a YouTube playlist that has to be fetched, anything else is a local
  // playlist already sitting in context state.
  const remoteListId = listId?.startsWith(REMOTE_PREFIX) ? listId.slice(REMOTE_PREFIX.length) : null
  const localListId = listId && remoteListId === null ? listId : null
  const localQueue = useMemo(() => {
    if (!localListId) return null
    const found = playlists.find((p) => p.id === localListId)
    return found ? { name: found.name, id: found.id, items: found.videos } : null
  }, [localListId, playlists])
  const { data: remoteQueue } = useAsync<{ name: string; items: QueueItem[] }>(
    async () => {
      const playlist = await window.api.getRemotePlaylist(remoteListId as string)
      return {
        name: playlist.title,
        items: playlist.items.map((v) => ({
          videoId: v.videoId,
          title: v.title,
          author: v.author,
          thumbnail: v.thumbnail,
          duration: v.duration
        }))
      }
    },
    [remoteListId],
    { enabled: remoteListId !== null }
  )
  // A YouTube queue that fails to load simply has no sidebar; the video itself
  // is still perfectly watchable, so this never surfaces as an error state.
  const queue =
    remoteListId !== null
      ? remoteQueue
        ? { name: remoteQueue.name, id: listId as string, items: remoteQueue.items }
        : null
      : localQueue

  const queueIndex = queue ? queue.items.findIndex((v) => v.videoId === videoId) : -1
  const activeQueueItemRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    // Keep the playing row inside the playlist pane. A bare `scrollIntoView`
    // would also scroll every scrollable ancestor — the main column included —
    // because a row in the right-hand pane sits outside its scrollport, so
    // changing videos would yank the description out of view.
    const item = activeQueueItemRef.current
    const list = item?.closest<HTMLElement>('.queue')
    if (!item || !list) return
    const itemRect = item.getBoundingClientRect()
    const listRect = list.getBoundingClientRect()
    const isReduced = document.documentElement.dataset.reducedMotion === 'true'
    const scrollBehavior: ScrollBehavior = isReduced ? 'auto' : 'smooth'
    if (itemRect.top < listRect.top) {
      list.scrollBy({ top: itemRect.top - listRect.top - 8, behavior: scrollBehavior })
    } else if (itemRect.bottom > listRect.bottom) {
      list.scrollBy({ top: itemRect.bottom - listRect.bottom + 8, behavior: scrollBehavior })
    }
  }, [queueIndex])

  const onEnded = useCallback(() => {
    // When a video finishes, reset its saved history position to 0 so watching it again starts at beginning
    if (settings.saveWatchHistory) {
      updateHistoryPosition(videoId, 0, details?.duration)
    }
    if (settings.autoplayPlaylists && queue && queueIndex >= 0) {
      const next = queue.items[queueIndex + 1]
      if (next) {
        if (isMini && onAdvanceVideo) {
          onAdvanceVideo(next.videoId)
        } else {
          navigate(`#/watch/${next.videoId}?list=${queue.id}`)
        }
      }
    }
  }, [videoId, queue, queueIndex, details?.duration, settings.autoplayPlaylists, settings.saveWatchHistory, updateHistoryPosition, isMini, onAdvanceVideo])

  const onTimeUpdate = useCallback(
    (position: number, duration: number) => {
      if (!settings.saveWatchHistory) return
      // If watched near the end (within 5 seconds or >=95%), record 0 so it restarts next time
      const isCompleted = duration > 0 && (position >= duration - 5 || position / duration >= 0.95)
      updateHistoryPosition(videoId, isCompleted ? 0 : position, duration)
    },
    [videoId, settings.saveWatchHistory, updateHistoryPosition]
  )

  const onSkipped = useCallback(
    (segment: SponsorSegment) => {
      toast(`Skipped ${sponsorCategoryLabel(segment.category)}`, {
        actionLabel: 'Undo',
        onAction: () => playerRef.current?.unskip(segment)
      })
    },
    [toast]
  )

  // Windows media keys / SMTC "previous" & "next" follow the queue when the
  // video was opened from a playlist, and fall back to chapters otherwise.
  const onMediaPrevious = useCallback(() => {
    if (queue && queueIndex > 0) {
      const prev = queue.items[queueIndex - 1]
      if (prev) {
        if (isMini && onAdvanceVideo) {
          onAdvanceVideo(prev.videoId)
        } else {
          navigate(`#/watch/${prev.videoId}?list=${queue.id}`)
        }
      }
      return
    }
    playerRef.current?.previousChapter()
  }, [queue, queueIndex, isMini, onAdvanceVideo])

  const onMediaNext = useCallback(() => {
    if (queue && queueIndex >= 0 && queueIndex < queue.items.length - 1) {
      const next = queue.items[queueIndex + 1]
      if (next) {
        if (isMini && onAdvanceVideo) {
          onAdvanceVideo(next.videoId)
        } else {
          navigate(`#/watch/${next.videoId}?list=${queue.id}`)
        }
      }
      return
    }
    playerRef.current?.nextChapter()
  }, [queue, queueIndex, isMini, onAdvanceVideo])

  const playlistNavigation = useMemo(() => {
    if (!queue) return null
    return {
      hasPrevious: queueIndex > 0,
      hasNext: queueIndex >= 0 && queueIndex < queue.items.length - 1,
      onPrevious: () => {
        if (queue && queueIndex > 0) {
          const prev = queue.items[queueIndex - 1]
          if (prev) {
            if (isMini && onAdvanceVideo) {
              onAdvanceVideo(prev.videoId)
            } else {
              navigate(`#/watch/${prev.videoId}?list=${queue.id}`)
            }
          }
        }
      },
      onNext: () => {
        if (queue && queueIndex >= 0 && queueIndex < queue.items.length - 1) {
          const next = queue.items[queueIndex + 1]
          if (next) {
            if (isMini && onAdvanceVideo) {
              onAdvanceVideo(next.videoId)
            } else {
              navigate(`#/watch/${next.videoId}?list=${queue.id}`)
            }
          }
        }
      }
    }
  }, [queue, queueIndex, isMini, onAdvanceVideo])

  const updateSettings = useCallback(
    (patch: Partial<Settings>) => {
      void saveSettings({ ...settings, ...patch })
    },
    [settings, saveSettings]
  )

  const copyLink = useCopyLink()

  const queueAsideRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const aside = queueAsideRef.current
    if (!aside) return

    const handleWheel = (event: WheelEvent): void => {
      if (event.deltaY === 0) return
      const list = aside.querySelector<HTMLElement>('.queue')
      if (!list) return

      // When cursor is over header or chrome (not the list itself), hand deltas to list
      if (event.target !== list && !list.contains(event.target as Node)) {
        const max = list.scrollHeight - list.clientHeight
        const next = Math.min(max, Math.max(0, list.scrollTop + event.deltaY))
        if (next !== list.scrollTop) {
          list.scrollTop = next
          event.preventDefault()
        }
      }
    }

    aside.addEventListener('wheel', handleWheel, { passive: false })
    return () => aside.removeEventListener('wheel', handleWheel)
  }, [queue, queueCollapsed])

  const playerMediaSession = useMemo(
    () =>
      details
        ? {
            title: details.title,
            artist: details.author,
            album: queue?.name,
            artwork: details.thumbnails[0]?.url,
            onNextTrack: onMediaNext,
            onPreviousTrack: onMediaPrevious
          }
        : undefined,
    [details, queue?.name, onMediaNext, onMediaPrevious]
  )

  const isUnavailable = Boolean(
    error || (!loading && (!details || !details.playable || !details.manifestUrl))
  )

  useEffect(() => {
    if (isMini && isUnavailable) {
      onClose?.()
    }
  }, [isMini, isUnavailable, onClose])

  if (isMini && isUnavailable) {
    return null
  }

  if (loading) {
    if (isMini) {
      return (
        <div className="watch watch--mini">
          <div className="watch__main watch__main--mini">
            <div className="watch__player watch__player--mini">
              <div className="miniplayer__loading">
                {onClose && (
                  <div
                    className="miniplayer__actions"
                    style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                  >
                    <button
                      type="button"
                      className="miniplayer__action-btn miniplayer__action-btn--close"
                      aria-label="Close miniplayer"
                      title="Close miniplayer"
                      onClick={onClose}
                    >
                      <Icon name="close" size={17} />
                    </button>
                  </div>
                )}
                <Spinner />
                <span className="miniplayer__loading-text">Loading video…</span>
              </div>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className={`page${typeof document !== 'undefined' && document.fullscreenElement ? ' page--fullscreen' : ''}`}>
        <Loader label="Loading video…" />
      </div>
    )
  }

  if (error || !details) {
    if (isMini) {
      return (
        <div className="watch watch--mini">
          <div className="watch__main watch__main--mini">
            <div className="watch__player watch__player--mini">
              <div className="miniplayer__error">
                <div
                  className="miniplayer__actions"
                  style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
                >
                  {onExpand && (
                    <button
                      type="button"
                      className="miniplayer__action-btn"
                      aria-label="Expand to full player"
                      title="Expand to full player"
                      onClick={onExpand}
                    >
                      <Icon name="openInFull" size={17} />
                    </button>
                  )}
                  {onClose && (
                    <button
                      type="button"
                      className="miniplayer__action-btn miniplayer__action-btn--close"
                      aria-label="Close miniplayer"
                      title="Close miniplayer"
                      onClick={onClose}
                    >
                      <Icon name="close" size={17} />
                    </button>
                  )}
                </div>
                <Icon name="close" size={20} />
                <span>Could not load video</span>
                {onClose && (
                  <button type="button" className="btn btn--text btn--sm" onClick={onClose}>
                    Close
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )
    }
    return (
      <div className="page">
        <EmptyState
          icon="close"
          title="Could not load video"
          message={error ?? 'Unknown error'}
        />
      </div>
    )
  }

  const likes = ryd?.likes ?? details.likeCount
  const dislikes = ryd?.dislikes ?? null

  const hasChapters = Boolean(details?.chapters && details.chapters.length > 0)
  const positionText = queue
    ? queueIndex >= 0
      ? `${queueIndex + 1} / ${queue.items.length}`
      : `${queue.items.length}`
    : ''

  return (
    <div
      ref={watchContainerRef}
      className={`watch${isMini ? ' watch--mini' : ''}${
        queue
          ? queueCollapsed
            ? ' watch--queue-collapsed'
            : ' watch--has-queue'
          : ' watch--solo'
      }`}
      style={!isMini && queue ? ({ '--queue-w': `${queueWidth}px` } as React.CSSProperties) : undefined}
    >
      <div className={`watch__main${isMini ? ' watch__main--mini' : ''}`}>
        <div
          ref={miniElRef}
          className={`watch__player${isMini ? ' watch__player--mini' : ''}`}
          style={
            isMini && miniBounds
              ? {
                  left: `${miniBounds.x}px`,
                  top: `${miniBounds.y}px`,
                  width: `${miniBounds.width}px`,
                  right: 'auto',
                  bottom: 'auto'
                }
              : undefined
          }
        >
          {details.playable && details.manifestUrl && ready ? (
            <Player
              key={videoId}
              ref={playerRef}
              videoId={videoId}
              manifestUrl={details.manifestUrl}
              isLive={details.isLive}
              poster={details.thumbnails[0]?.url}
              captions={details.captions}
              chapters={details.chapters}
              startPosition={details.isLive ? 0 : resume}
              autoplay
              segments={segments}
              autoSkip={settings.autoSkip}
              sponsorBlockEnabled={settings.sponsorBlockEnabled}
              alwaysShowCaptions={effectiveCaptions}
              subtitleStyle={settings.subtitleStyle}
              initialVolume={effectiveVolume}
              initialSpeed={effectiveSpeed}
              preferredQuality={settings.preferredQuality}
              preservePitch={settings.preservePitch}
              skipSilence={settings.skipSilence}
              defaultAudioLanguage={details.defaultAudioLanguage ?? null}
              playlistNavigation={playlistNavigation}
              onPitchChange={(value) => updateSettings({ preservePitch: value })}
              onSkipSilenceChange={(value) => updateSettings({ skipSilence: value })}
              onSubtitleStyleChange={(subtitleStyle) => updateSettings({ subtitleStyle })}
              onSpeedChange={(speed) => {
                if (listId) setPlaylistSpeed(listId, speed)
              }}
              onVolumeChange={(volume) => {
                if (listId) setPlaylistVolume(listId, volume)
              }}
              onCaptionsToggle={(enabled) => {
                if (listId) setPlaylistCaptions(listId, enabled)
              }}
              onFullscreenChange={(isFs) => {
                if (listId) setPlaylistFullscreen(listId, isFs)
              }}
              onTimeUpdate={onTimeUpdate}
              onEnded={onEnded}
              onSkipped={onSkipped}
              mediaSession={playerMediaSession}
              isMini={isMini}
              onExpand={handleExpand}
              onClose={onClose}
              title={details.title}
              author={details.author}
              onMiniHeaderPointerDown={handleMiniHeaderPointerDown}
              onMiniResizePointerDown={handleMiniResizePointerDown}
            />
          ) : isMini ? (
            <div className="miniplayer__error">
              <div
                className="miniplayer__actions"
                style={{ position: 'absolute', top: 8, right: 8, zIndex: 10 }}
              >
                {handleExpand && (
                  <button
                    type="button"
                    className="miniplayer__action-btn"
                    aria-label="Expand to full player"
                    title="Expand to full player"
                    onClick={handleExpand}
                  >
                    <Icon name="openInFull" size={17} />
                  </button>
                )}
                {onClose && (
                  <button
                    type="button"
                    className="miniplayer__action-btn miniplayer__action-btn--close"
                    aria-label="Close miniplayer"
                    title="Close miniplayer"
                    onClick={onClose}
                  >
                    <Icon name="close" size={17} />
                  </button>
                )}
              </div>
              <Icon name="info" size={20} />
              <span>{details.isLive ? 'Live stream unavailable' : 'Video unavailable'}</span>
              {onClose && (
                <button type="button" className="btn btn--text btn--sm" onClick={onClose}>
                  Close
                </button>
              )}
            </div>
          ) : (
            <div className="player__error">
              <span className="player__error-icon">
                <Icon name={details.isLive ? 'close' : 'info'} size={26} />
              </span>
              <div>
                <p className="player__error-title">
                  {details.isLive ? 'Live stream is currently unavailable' : 'This video is unavailable'}
                </p>
                <p>{details.reason ?? 'It may be private, region-locked or age-restricted.'}</p>
              </div>
              <div className="player__error-actions">
                <button
                  type="button"
                  className="btn btn--tonal btn--sm"
                  onClick={() => navigate('#/')}
                >
                  <Icon name="back" size={16} />
                  Back to home
                </button>
                {details.authorId && (
                  <button
                    type="button"
                    className="btn btn--tonal btn--sm"
                    onClick={() => navigate(`#/channel/${details.authorId}`)}
                  >
                    <Icon name="person" size={16} />
                    Visit {details.author}
                  </button>
                )}
                <button
                  type="button"
                  className="btn btn--text btn--sm"
                  onClick={() => window.history.back()}
                >
                  <Icon name="back" size={16} />
                  Go back
                </button>
              </div>
            </div>
          )}
        </div>

        {!isMini && (
          <>
            <h1 className="watch__title">{details.title}</h1>


        <div className="watch__bar">
          <div className="watch__channel-group">
            <button
              className="watch__channel"
              title={`Open ${details.author}'s channel`}
              onClick={() => {
                if (details.authorId) {
                  navigate(`#/channel/${details.authorId}`)
                } else if (details.author) {
                  navigate(`#/search?q=${encodeURIComponent(details.author)}&f=channels`)
                }
              }}
            >
              {authorAvatar && !avatarFailed ? (
                <img
                  className="watch__channel-avatar"
                  src={authorAvatar}
                  alt=""
                  referrerPolicy="no-referrer"
                  onError={onAvatarError}
                />
              ) : (
                <div className="watch__channel-avatar watch__channel-avatar--fallback">
                  {details.author.slice(0, 1).toUpperCase()}
                </div>
              )}
              <div className="watch__channel-text">
                <div className="watch__channel-name">{details.author}</div>
                <div className="watch__channel-sub">
                  {details.authorId ? 'Creator' : 'Channel'}
                </div>
              </div>
            </button>
          </div>

          <div className="watch__actions">
            <span className="chip chip--split" title="Likes / Dislikes">
              <span className="chip__part">
                <Icon name="like" size={18} />
                {likes != null ? formatCount(likes) : 'Like'}
              </span>
              {settings.showDislikes && (
                <>
                  <span className="chip__divider" />
                  <span className="chip__part">
                    <Icon name="dislike" size={18} />
                    {dislikes != null ? formatCount(dislikes) : '—'}
                  </span>
                </>
              )}
            </span>
            <button
              className="chip"
              onClick={() =>
                setAddVideo(
                  toPlaylistVideo({
                    videoId: details.videoId,
                    title: details.title,
                    author: details.author,
                    authorId: details.authorId,
                    authorAvatar: details.authorThumbnail,
                    viewCount: details.viewCount,
                    published: details.relativeDate || details.publishDate,
                    publishTimestamp: details.publishTimestamp,
                    isPremiere: details.isPremiere,
                    isStreamed: details.isStreamed,
                    isLive: details.isLive,
                    thumbnail: details.thumbnails[0]?.url ?? '',
                    duration: details.duration || null
                  })
                )
              }
            >
              <Icon name="bookmark" size={18} />
              Save
            </button>
            <button
              className="chip"
              onClick={() => copyLink(videoUrl(details.videoId || videoId))}
            >
              <Icon name="link" size={18} />
              Copy link
            </button>
            {queue && (
              <button
                type="button"
                className={`chip watch__queue-toggle${!queueCollapsed ? ' chip--active' : ''}`}
                onClick={toggleQueue}
                aria-label={queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}
                title={queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}
              >
                <Icon name="playlist" size={18} />
                <span>{queueCollapsed ? 'Expand playlist' : 'Collapse playlist'}</span>
              </button>
            )}
          </div>
        </div>

        {hasChapters && (
          <div className="watch__chapters">
            <div className="watch__chapters-header">
              <div className="watch__chapters-title">
                <Icon name="chapters" size={18} />
                <span>Chapters</span>
                <span className="watch__chapters-count">{details.chapters.length}</span>
              </div>
            </div>
            <div className="watch__chapters-carousel">
              {details.chapters.map((ch, idx) => (
                <button
                  key={`${ch.start}-${idx}`}
                  type="button"
                  className="watch__chapter-card"
                  onClick={() => {
                    playerRef.current?.seekTo(ch.start)
                    scrollPageToTop()
                  }}
                  title={`${ch.title} (${formatTime(ch.start)} - ${formatTime(ch.end)})`}
                >
                  <div className="watch__chapter-card-thumb-wrap">
                    {ch.thumbnail ? (
                      <img
                        src={ch.thumbnail}
                        alt=""
                        className="watch__chapter-card-thumb"
                        loading="lazy"
                      />
                    ) : (
                      <div className="watch__chapter-card-thumb-fallback">
                        <Icon name="play" size={16} />
                      </div>
                    )}
                    <span className="watch__chapter-card-time">{formatTime(ch.start)}</span>
                  </div>
                  <div className="watch__chapter-card-meta">
                    <span className="watch__chapter-card-name">{ch.title}</span>
                    <span className="watch__chapter-card-dur">{formatTime(ch.end - ch.start)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <div
          className={[
            'watch__description',
            expandable && 'watch__description--expandable',
            descOpen && 'watch__description--open'
          ]
            .filter(Boolean)
            .join(' ')}
        >
          <span className="watch__description-text" ref={descRef}>
            <strong>
              {(() => {
                const parts: string[] = []
                if (details.viewCount != null) {
                  parts.push(`${formatCount(details.viewCount)} views`)
                }
                const dateStr = details.publishDate
                let relStr = details.relativeDate
                if (!relStr && details.publishTimestamp) {
                  relStr = formatRelative(details.publishTimestamp)
                }
                if (!relStr && dateStr) {
                  const m = dateStr.match(/([A-Za-z]+ \d{1,2}, \d{4}|\d{4}-\d{2}-\d{2})/)
                  if (m) {
                    const parsed = Date.parse(m[1])
                    if (!Number.isNaN(parsed)) relStr = formatRelative(parsed)
                  }
                }
                if (dateStr && relStr) {
                  if (dateStr.toLowerCase().includes(relStr.toLowerCase())) {
                    parts.push(dateStr)
                  } else {
                    parts.push(`${dateStr} · ${relStr}`)
                  }
                } else if (dateStr) {
                  parts.push(dateStr)
                } else if (relStr) {
                  parts.push(relStr)
                }
                return parts.join(' · ')
              })()}
            </strong>
            {'\n'}
            {details.description
              ? renderDescriptionWithTimestamps(details.description, (sec) =>
                  playerRef.current?.seekTo(sec)
                )
              : 'No description.'}
          </span>
          {expandable && (
            <button
              type="button"
              className="watch__description-toggle"
              onClick={() => setDescOpen((prev) => !prev)}
            >
              {descOpen ? 'Show less' : 'Show more'}
            </button>
          )}
        </div>
          </>
        )}
      </div>

      {!isMini && queue && (
        <aside
          ref={queueAsideRef}
          className={`watch__side${queueCollapsed ? ' watch__side--collapsed' : ''}`}
          aria-hidden={queueCollapsed}
        >
          <div
            className="watch__side-resizer"
            onPointerDown={handleQueueResizePointerDown}
            title="Drag to resize playlist (drag below 200px to collapse)"
          />
          <div className="watch__side-head">
            <h2 className="watch__side-title" title={`${queue.name} · ${positionText}`}>
              <span className="watch__side-name">{queue.name}</span>
              <span className="watch__side-sep"> · </span>
              <span className="watch__side-pos">{positionText}</span>
            </h2>
            <div className="watch__side-actions">
              <button
                type="button"
                className={`icon-btn${settings.autoplayPlaylists ? ' icon-btn--active' : ''}`}
                title={settings.autoplayPlaylists ? 'Autoplay is on' : 'Autoplay is off'}
                aria-label={settings.autoplayPlaylists ? 'Autoplay is on' : 'Autoplay is off'}
                onClick={() => updateSettings({ autoplayPlaylists: !settings.autoplayPlaylists })}
              >
                <Icon name="autoplay" size={20} />
              </button>
              <button
                type="button"
                className="icon-btn"
                title="Collapse playlist"
                aria-label="Collapse playlist"
                onClick={toggleQueue}
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          </div>

          <div className="queue">
            {queue.items.map((video, index) => {
              const isActive = index === queueIndex
              const progress = getHistoryProgress(video.videoId, video.duration)
              const histPct = progress > 0 ? Math.min(100, Math.max(0, progress * 100)) : 0
              return (
                <button
                  key={`${video.videoId}-${index}`}
                  ref={isActive ? activeQueueItemRef : undefined}
                  className={`queue__item${isActive ? ' queue__item--active' : ''}`}
                  onClick={() => navigate(`#/watch/${video.videoId}?list=${queue.id}`)}
                >
                  <div className="queue__thumb-wrap">
                    <img className="queue__thumb" src={video.thumbnail} alt="" loading="lazy" />
                    <span className="queue__index">{index + 1}</span>
                    {histPct > 0 && (
                      <div className="video-card__progress">
                        <i style={{ width: `${histPct}%` }} />
                      </div>
                    )}
                  </div>
                  <div>
                    <div className="queue__title">{video.title}</div>
                    <div className="queue__meta">{video.author}</div>
                  </div>
                </button>
              )
            })}
          </div>
        </aside>
      )}

      {!isMini && addVideo && (
        <AddToPlaylistDialog video={addVideo} onClose={() => setAddVideo(null)} />
      )}
    </div>
  )
}
