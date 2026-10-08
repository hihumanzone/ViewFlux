import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { VideoCard } from '../components/VideoCard'
import { ChannelCard, PlaylistCard } from '../components/ResultCards'
import { EmptyState, Loader } from '../components/EmptyState'
import { Icon } from '../components/Icons'
import { ListRow } from '../components/ListRow'
import { ChannelLine } from '../components/ChannelLine'
import { VideoOptions } from '../components/VideoOptions'
import { MasonryGrid } from '../components/MasonryGrid'
import { ViewModeToggle } from '../components/ViewModeToggle'
import { useViewMode } from '../lib/useViewMode'
import { navigate, searchRoute } from '../lib/router'
import { resolveYouTubeUrl } from '../lib/youtubeUrl'
import { useApp } from '../state/AppContext'
import { formatCount, formatRelative, formatVideoPublished, safeText } from '../lib/format'
import { scrollPageToTop } from '../lib/scroll'
import { enrichVideoWithHistory } from '../lib/enrich'
import type { SearchFilter, SearchItem, VideoSummary } from '../../../shared/types'

const FILTERS: { id: SearchFilter; label: string; icon: 'search' | 'play' | 'person' | 'playlist' | 'album' | 'music_note' }[] = [
  { id: 'all', label: 'All', icon: 'search' },
  { id: 'videos', label: 'Videos', icon: 'play' },
  { id: 'channels', label: 'Channels', icon: 'person' },
  { id: 'playlists', label: 'Playlists', icon: 'playlist' },
  { id: 'albums', label: 'Albums', icon: 'album' },
  { id: 'music', label: 'Music', icon: 'music_note' }
]

export function SearchPage({
  query,
  filter
}: {
  query: string
  filter: SearchFilter
}): React.JSX.Element {
  const {
    settings,
    searchHistory,
    recordSearch,
    removeSearch,
    clearSearchHistory,
    confirm,
    isYoutubePlaylistSaved,
    saveYoutubePlaylistSummary,
    removeYoutubePlaylist,
    historyMap
  } = useApp()
  const [viewMode, setViewMode] = useViewMode('search')
  const [input, setInput] = useState(query)
  const [suggestions, setSuggestions] = useState<string[]>([])
  const [showSuggestions, setShowSuggestions] = useState(false)
  const [activeSuggestion, setActiveSuggestion] = useState(-1)
  const [results, setResults] = useState<SearchItem[]>([])
  const [continuation, setContinuation] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const sentinelRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const searchBarFieldRef = useRef<HTMLDivElement>(null)
  const requestRef = useRef(0)
  const suggRequestRef = useRef(0)
  const suggTimer = useRef<number | null>(null)

  // Close suggestions when clicking anywhere outside the search field
  useEffect(() => {
    if (!showSuggestions) return
    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node | null
      if (!target) return
      if (searchBarFieldRef.current?.contains(target)) return
      setShowSuggestions(false)
    }
    const onPointerUp = (): void => {
      // Seamlessly restore focus to the search input after clicking/dragging the scrollbar
      if (document.activeElement !== inputRef.current) {
        inputRef.current?.focus({ preventScroll: true })
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('pointerup', onPointerUp, true)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('pointerup', onPointerUp, true)
    }
  }, [showSuggestions])

  const cancelSuggestions = useCallback(() => {
    if (suggTimer.current) {
      window.clearTimeout(suggTimer.current)
      suggTimer.current = null
    }
    suggRequestRef.current++
    setShowSuggestions(false)
    setSuggestions([])
    setActiveSuggestion(-1)
  }, [])

  useEffect(() => {
    setInput(query)
    cancelSuggestions()
  }, [query, cancelSuggestions])

  // The app dispatches this when the user presses `/` anywhere outside a text
  // field, so search is always one keystroke away from any screen.
  useEffect(() => {
    const focus = (): void => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
    window.addEventListener('viewflux:focus-search', focus)
    return () => window.removeEventListener('viewflux:focus-search', focus)
  }, [])

  // Run the search (and remember it in search history).
  useEffect(() => {
    cancelSuggestions()
    const q = query.trim()
    const id = ++requestRef.current
    if (!q) {
      setResults([])
      setContinuation(null)
      setError(null)
      setLoading(false)
      setLoadingMore(false)
      return
    }
    const directRoute = resolveYouTubeUrl(q)
    if (directRoute) {
      navigate(directRoute)
      return
    }
    if (settings.saveSearchHistory) void recordSearch(q)
    setLoading(true)
    setError(null)
    setResults([])
    setContinuation(null)
    scrollPageToTop('auto')
    void window.api
      .search(q, filter)
      .then((page) => {
        if (requestRef.current !== id) return
        setResults(page.items)
        setContinuation(page.continuation)
      })
      .catch((err: unknown) => {
        if (requestRef.current === id) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (requestRef.current === id) setLoading(false)
      })
  }, [query, filter, settings.saveSearchHistory, recordSearch, cancelSuggestions])

  const loadMore = useCallback(async () => {
    if (!continuation || loadingMore) return
    const id = requestRef.current
    setLoadingMore(true)
    try {
      const page = await window.api.searchMore(continuation)
      if (requestRef.current !== id) return
      setResults((prev) => {
        const keyOf = (item: SearchItem): string =>
          item.type === 'video' ? `video:${item.videoId}` : `${item.type}:${item.id}`
        const seen = new Set(prev.map(keyOf))
        return [...prev, ...page.items.filter((item) => !seen.has(keyOf(item)))]
      })
      setContinuation(page.continuation)
    } catch {
      if (requestRef.current === id) setContinuation(null)
    } finally {
      if (requestRef.current === id) setLoadingMore(false)
    }
  }, [continuation, loadingMore])

  useEffect(() => {
    const el = sentinelRef.current
    if (!el) return
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) void loadMore()
      },
      { rootMargin: '600px' }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [loadMore])

  const onInputChange = (value: string): void => {
    setInput(value)
    setActiveSuggestion(-1)
    if (suggTimer.current) {
      window.clearTimeout(suggTimer.current)
      suggTimer.current = null
    }
    const reqId = ++suggRequestRef.current

    if (!value.trim()) {
      setSuggestions([])
      setShowSuggestions(false)
      return
    }
    const directRoute = resolveYouTubeUrl(value)
    if (directRoute) {
      cancelSuggestions()
      setInput('')
      navigate(directRoute)
      return
    }
    suggTimer.current = window.setTimeout(() => {
      void window.api.suggestions(value.trim()).then((items) => {
        if (suggRequestRef.current !== reqId) return
        if (document.activeElement !== inputRef.current) return
        setSuggestions(items)
        setShowSuggestions(items.length > 0)
      })
    }, 180)
  }

  const onInputPaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData?.getData('text')
    if (text) {
      const directRoute = resolveYouTubeUrl(text)
      if (directRoute) {
        event.preventDefault()
        cancelSuggestions()
        setInput('')
        navigate(directRoute)
      }
    }
  }

  const onInputDrop = (event: React.DragEvent<HTMLInputElement>): void => {
    const text = event.dataTransfer?.getData('text')
    if (text) {
      const directRoute = resolveYouTubeUrl(text)
      if (directRoute) {
        event.preventDefault()
        cancelSuggestions()
        setInput('')
        navigate(directRoute)
      }
    }
  }

  const searchStatus = useMemo(() => {
    const q = query.trim()
    if (!q) return ''
    if (loading) return `Searching for ${q}`
    if (error) return `Search for ${q} failed`
    const total = results.length
    if (total === 0) return `No results for ${q}`
    const noun = total === 1 ? 'result' : 'results'
    return `${total} ${noun} for ${q}${loadingMore ? ', loading more' : ''}`
  }, [query, loading, error, results.length, loadingMore])

  const submit = (value?: string): void => {
    const q = (value ?? input).trim()
    cancelSuggestions()
    if (!q) return
    const directRoute = resolveYouTubeUrl(q)
    if (directRoute) {
      setInput('')
      navigate(directRoute)
      return
    }
    navigate(searchRoute(q, filter))
  }

  const fillSearch = (queryText: string): void => {
    cancelSuggestions()
    setInput(queryText)
    if (inputRef.current) {
      inputRef.current.focus()
      inputRef.current.setSelectionRange(queryText.length, queryText.length)
    }
  }

  const goFilter = (next: SearchFilter): void => {
    if (query.trim()) navigate(searchRoute(query, next))
    else navigate(searchRoute('', next))
  }

  const onInputKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActiveSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1))
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActiveSuggestion((prev) => Math.max(prev - 1, -1))
    } else if (event.key === 'Enter') {
      event.preventDefault()
      submit(activeSuggestion >= 0 ? suggestions[activeSuggestion] : undefined)
    } else if (event.key === 'Escape') {
      cancelSuggestions()
    }
  }

  useEffect(() => {
    if (activeSuggestion >= 0) {
      const el = document.getElementById(`search-suggestion-${activeSuggestion}`)
      el?.scrollIntoView({ block: 'nearest' })
    }
  }, [activeSuggestion])

  const renderItem = (item: SearchItem, index: number): React.JSX.Element => {
    if (item.type === 'video') {
      const rawVideo = item as VideoSummary & { type: 'video' }
      const video = enrichVideoWithHistory(rawVideo, historyMap)
      return (
        <VideoCard
          key={`v-${video.videoId}-${index}`}
          video={video}
        />
      )
    }
    if (item.type === 'channel') {
      return <ChannelCard key={`c-${item.id}-${index}`} channel={item} viewMode="grid" />
    }
    return (
      <PlaylistCard
        key={`p-${item.id}-${index}`}
        playlist={item}
        // Playlist search results get the same save/remove affordance as the
        // playlist's own page, so the saved state is visible right in results.
        saved={isYoutubePlaylistSaved(item.id)}
        onSave={() => void saveYoutubePlaylistSummary(item)}
        onRemove={(target) => void removeYoutubePlaylist(target.id)}
      />
    )
  }

  const renderListItem = (item: SearchItem, index: number): React.JSX.Element => {
    if (item.type === 'video') {
      const rawVideo = item as VideoSummary & { type: 'video' }
      const video = enrichVideoWithHistory(rawVideo, historyMap)
      return (
        <ListRow
          key={`v-${video.videoId}-${index}`}
          to={`#/watch/${video.videoId}`}
          videoId={video.videoId}
          thumbnail={video.thumbnail}
          title={video.title}
          duration={video.duration}
          isLive={video.isLive}
          isPremiere={video.isPremiere}
          thumbSquare={video.isMusicTrack}
          actions={<VideoOptions video={video} label="Video options" />}
        >
          <ChannelLine
            name={video.author}
            channelId={video.authorId}
            avatar={video.isMusicTrack ? null : (video.authorAvatar ?? null)}
          />
          <div className="list-row__stats">
            {[
              video.album ? safeText(video.album) : null,
              video.viewCount != null ? `${formatCount(video.viewCount)} views` : null,
              !video.isMusicTrack ? formatVideoPublished(video) : null
            ].filter(Boolean).join(' · ')}
          </div>
        </ListRow>
      )
    }
    if (item.type === 'channel') {
      return (
        <li key={`c-${item.id}-${index}`} style={{ listStyle: 'none' }}>
          <ChannelCard channel={item} viewMode="list" />
        </li>
      )
    }
    return (
      <li key={`p-${item.id}-${index}`} style={{ listStyle: 'none' }}>
        <PlaylistCard
          playlist={item}
          saved={isYoutubePlaylistSaved(item.id)}
          onSave={() => void saveYoutubePlaylistSummary(item)}
          onRemove={(target) => void removeYoutubePlaylist(target.id)}
        />
      </li>
    )
  }

  const clearAll = async (): Promise<void> => {
    const ok = await confirm('Clear your search history?', {
      confirmLabel: 'Clear all',
      danger: true
    })
    if (!ok) return
    await clearSearchHistory()
  }

  return (
    <div className="page page--search">
      <div className="search-header">
        <form
          className="search-bar"
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
        >
          <div ref={searchBarFieldRef} className="search-bar__field">
            <Icon name="search" size={20} className="search-bar__lead" />
            <input
              ref={inputRef}
              className="search-bar__input"
              placeholder="Search videos, channels, playlists, or paste a YouTube link…"
              value={input}
              autoFocus
              role="combobox"
              aria-expanded={showSuggestions && suggestions.length > 0}
              aria-controls="search-suggestions"
              aria-autocomplete="list"
              aria-activedescendant={
                showSuggestions && activeSuggestion >= 0
                  ? `search-suggestion-${activeSuggestion}`
                  : undefined
              }
              aria-label="Search"
              onChange={(e) => onInputChange(e.target.value)}
              onPaste={onInputPaste}
              onDrop={onInputDrop}
              onKeyDown={onInputKeyDown}
              onFocus={() => suggestions.length > 0 && setShowSuggestions(true)}
              onBlur={(event) => {
                const nextTarget = event.relatedTarget as Node | null
                // Close suggestions when keyboard navigation (Tab key) moves focus outside the search bar
                if (nextTarget && !searchBarFieldRef.current?.contains(nextTarget)) {
                  setShowSuggestions(false)
                }
              }}
            />
            {input && (
              <button
                type="button"
                className="icon-btn icon-btn--sm search-bar__clear"
                aria-label="Clear"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  onInputChange('')
                  setInput('')
                  inputRef.current?.focus()
                }}
              >
                <Icon name="close" size={18} />
              </button>
            )}
            {showSuggestions && suggestions.length > 0 && (
              <div
                className="suggestions"
                id="search-suggestions"
                role="listbox"
                aria-label="Search suggestions"
                onMouseDown={(e) => {
                  // Prevent the search input from losing focus when clicking or dragging the scrollbar
                  e.preventDefault()
                }}
              >
                <div
                  className="suggestions__content"
                  onMouseDown={(e) => {
                    e.preventDefault()
                  }}
                >
                  {suggestions.map((s, index) => (
                    <button
                      type="button"
                      key={s}
                      id={`search-suggestion-${index}`}
                      role="option"
                      aria-selected={index === activeSuggestion}
                      className={`suggestions__item${index === activeSuggestion ? ' suggestions__item--active' : ''}`}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        submit(s)
                      }}
                    >
                      <Icon name="search" size={18} />
                      <span>{s}</span>
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
          <button type="submit" className="btn btn--filled">
            <Icon name="search" size={18} />
            Search
          </button>
        </form>

        {query && (
          <div className="search-header__filter-row">
            <div className="filter-chips" role="tablist" aria-label="Search filters">
              {FILTERS.map((f) => (
                <button
                  key={f.id}
                  role="tab"
                  aria-selected={filter === f.id}
                  className={`filter-chip${filter === f.id ? ' filter-chip--active' : ''}`}
                  onClick={() => goFilter(f.id)}
                >
                  <Icon name={f.icon} size={16} />
                  {f.label}
                </button>
              ))}
            </div>
            <ViewModeToggle value={viewMode} onChange={setViewMode} />
          </div>
        )}
      </div>

      {/* Announced politely so a screen reader hears the result count without
          the focus ever leaving the search field. */}
      <p className="sr-only" role="status" aria-live="polite">
        {searchStatus}
      </p>

      {loading && <Loader label="Searching…" />}

      {!loading && error && (
        <EmptyState icon="close" title="Search failed" message={error} />
      )}

      {!loading && !query.trim() && !error && (
        <div className="search-empty-content animate-fade-up">
          {settings.saveSearchHistory && searchHistory.length > 0 ? (
            <div className="recent">
              <div className="recent__head">
                <Icon name="history" size={18} />
                <span className="recent__title">Recent searches</span>
                <div className="recent__spacer" />
                <button className="btn btn--tonal btn--sm" onClick={() => void clearAll()}>
                  <Icon name="delete" size={16} />
                  Clear all
                </button>
              </div>
              <div className="recent__list">
                {searchHistory.map((entry) => (
                  <div key={entry.query} className="recent__item">
                    <button
                      className="recent__query"
                      onClick={() => navigate(searchRoute(entry.query, filter))}
                    >
                      <Icon name="search" size={16} />
                      <span>{entry.query}</span>
                    </button>
                    <span className="recent__at">{formatRelative(entry.searchedAt)}</span>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm recent__fill"
                      title="Fill into search bar"
                      aria-label={`Fill “${entry.query}” into search bar`}
                      onClick={() => fillSearch(entry.query)}
                    >
                      <Icon name="northWest" size={16} />
                    </button>
                    <button
                      type="button"
                      className="icon-btn icon-btn--sm recent__remove"
                      title="Remove from history"
                      aria-label={`Remove “${entry.query}” from search history`}
                      onClick={() => void removeSearch(entry.query)}
                    >
                      <Icon name="close" size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <EmptyState
              hero
              iconSize={34}
              icon="search"
              title="Search YouTube"
              message={
                <>
                  Find videos, channels, playlists and music — then watch them here,
                  <br />
                  distraction-free.
                </>
              }
            />
          )}
        </div>
      )}

      {!loading && query.trim() && results.length === 0 && !error && (
        <EmptyState
          icon="search"
          title="No results"
          message="Try a different search term or filter."
        />
      )}

      {Boolean(query.trim()) && results.length > 0 && (
        <div key={`${query}|${filter}`} className="search-results-wrap animate-fade-up">
          {viewMode === 'grid' ? (
            <MasonryGrid>
              {results.map((item, index) => renderItem(item, index))}
            </MasonryGrid>
          ) : (
            <ul className="list animate-fade-up">
              {results.map((item, index) => renderListItem(item, index))}
            </ul>
          )}
          <div ref={sentinelRef} />
          {loadingMore && <Loader />}
        </div>
      )}
    </div>
  )
}
