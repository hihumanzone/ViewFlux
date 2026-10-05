import { memo } from 'react'
import { Icon } from './Icons'
import type { ViewMode } from '../lib/useViewMode'

export const ViewModeToggle = memo(function ViewModeToggle({
  value,
  onChange,
  className = ''
}: {
  value: ViewMode
  onChange: (mode: ViewMode) => void
  className?: string
}): React.JSX.Element {
  return (
    <div className={`view-mode-toggle ${className}`} role="group" aria-label="Layout view mode">
      <button
        type="button"
        className={`view-mode-toggle__btn${value === 'grid' ? ' view-mode-toggle__btn--active' : ''}`}
        aria-pressed={value === 'grid'}
        onClick={() => onChange('grid')}
        title="Grid view"
        aria-label="Grid view"
      >
        <Icon name="grid" size={16} />
      </button>
      <button
        type="button"
        className={`view-mode-toggle__btn${value === 'list' ? ' view-mode-toggle__btn--active' : ''}`}
        aria-pressed={value === 'list'}
        onClick={() => onChange('list')}
        title="List view"
        aria-label="List view"
      >
        <Icon name="list" size={16} />
      </button>
    </div>
  )
})
