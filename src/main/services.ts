import type { RydResult, SponsorSegment } from '../shared/types'
import { USER_AGENT } from './http'

const SPONSOR_API = 'https://sponsor.ajay.app/api/skipSegments'
const RYD_API = 'https://returnyoutubedislikeapi.com/votes'

interface RawSponsorSegment {
  category: string
  segment: [number, number]
  UUID: string
  actionType: string
  votes: number
  locked: number
}

export async function fetchSponsorSegments(
  videoId: string,
  categories: string[]
): Promise<SponsorSegment[]> {
  if (categories.length === 0) return []
  const url = new URL(SPONSOR_API)
  url.searchParams.set('videoID', videoId)
  url.searchParams.set('categories', JSON.stringify(categories))

  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000)
    })
    // 404 simply means "no segments for this video" — normal, not an error.
    if (res.status === 404 || !res.ok) return []
    const data = (await res.json()) as RawSponsorSegment[]
    return data.map((seg) => ({
      category: seg.category,
      segment: seg.segment,
      uuid: seg.UUID,
      actionType: seg.actionType,
      votes: seg.votes,
      locked: Boolean(seg.locked)
    }))
  } catch {
    return []
  }
}

export async function fetchDislikes(videoId: string): Promise<RydResult | null> {
  try {
    const url = new URL(RYD_API)
    url.searchParams.set('videoId', videoId)
    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(5000)
    })
    if (!res.ok) return null
    const data = (await res.json()) as {
      likes?: number
      dislikes?: number
      rating?: number
      viewCount?: number
    }
    if (typeof data.likes !== 'number' || typeof data.dislikes !== 'number') return null
    return {
      likes: data.likes,
      dislikes: data.dislikes,
      rating: data.rating ?? 0,
      viewCount: data.viewCount ?? 0
    }
  } catch {
    return null
  }
}
