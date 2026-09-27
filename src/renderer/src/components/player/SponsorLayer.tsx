import {
  SPONSOR_CATEGORY_COLORS,
  sponsorCategoryLabel,
  type SponsorSegment
} from '../../../../shared/types'
import { clamp01 } from './types'

const SPONSOR_COLOR_FALLBACK = '#2ba640'

export function SponsorLayer({
  segments,
  duration
}: {
  segments: SponsorSegment[]
  duration: number
}): React.JSX.Element {
  if (duration <= 0 || segments.length === 0) return <></>
  return (
    <div className="seek__sponsors" aria-hidden="true">
      {segments.map((s) => {
        const [start, end] = s.segment
        const left = clamp01(start / duration) * 100
        const width = clamp01((end - start) / duration) * 100
        const color = SPONSOR_CATEGORY_COLORS[s.category] ?? SPONSOR_COLOR_FALLBACK
        return (
          <div
            key={s.uuid}
            className="seek__sponsor-segment"
            title={sponsorCategoryLabel(s.category)}
            style={{
              left: `${left}%`,
              width: `${width}%`,
              background: color
            }}
          />
        )
      })}
    </div>
  )
}
