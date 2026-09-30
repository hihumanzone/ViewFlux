import { useRef, type FormEvent } from 'react'
import { Icon } from './Icons'
import { resolveYouTubeUrl } from '../lib/youtubeUrl'
import { navigate } from '../lib/router'

interface InlineSearchProps {
  value: string
  onChange: (value: string) => void
  placeholder: string
  /** Accessible name for the text field. */
  ariaLabel: string
  /** Runs when the search button (or Enter) is pressed. Filtering is live, so this is optional. */
  onSubmit?: (value: string) => void
  className?: string
}

/**
 * Secondary search field for filtering a list inside a page (History, Saved
 * Channels). It reuses the main search bar's own markup — 48px pill field,
 * muted lead icon, clear button and a filled search button on the right — so
 * every search box in the app shares the same look and proportions instead of
 * the old shrunken variants.
 */
export function InlineSearch({
  value,
  onChange,
  placeholder,
  ariaLabel,
  onSubmit,
  className
}: InlineSearchProps): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null)

  const handlePaste = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData?.getData('text')
    if (text) {
      const directRoute = resolveYouTubeUrl(text)
      if (directRoute) {
        event.preventDefault()
        onChange('')
        navigate(directRoute)
      }
    }
  }

  const handleDrop = (event: React.DragEvent<HTMLInputElement>): void => {
    const text = event.dataTransfer?.getData('text')
    if (text) {
      const directRoute = resolveYouTubeUrl(text)
      if (directRoute) {
        event.preventDefault()
        onChange('')
        navigate(directRoute)
      }
    }
  }

  const handleSubmit = (event: FormEvent): void => {
    event.preventDefault()
    const directRoute = resolveYouTubeUrl(value)
    if (directRoute) {
      onChange('')
      navigate(directRoute)
      return
    }
    onSubmit?.(value)
    inputRef.current?.blur()
  }

  return (
    <form
      className={['search-bar', 'search-bar--compact', className].filter(Boolean).join(' ')}
      role="search"
      onSubmit={handleSubmit}
    >
      <div className="search-bar__field">
        <Icon name="search" size={20} className="search-bar__lead" />
        <input
          ref={inputRef}
          type="text"
          className="search-bar__input"
          placeholder={placeholder}
          aria-label={ariaLabel}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onPaste={handlePaste}
          onDrop={handleDrop}
        />
        {value && (
          <button
            type="button"
            className="icon-btn icon-btn--sm search-bar__clear"
            aria-label="Clear search"
            onClick={() => {
              onChange('')
              inputRef.current?.focus()
            }}
          >
            <Icon name="close" size={18} />
          </button>
        )}
      </div>
      <button
        type="submit"
        className="btn btn--filled search-bar__submit"
        aria-label="Search"
        title="Search"
      >
        <Icon name="search" size={18} />
      </button>
    </form>
  )
}
