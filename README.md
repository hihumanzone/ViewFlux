# ViewFlux Desktop

A fast, native **Windows** YouTube client focused on one thing: **searching for and watching videos**.
It is a modern, lightweight desktop client inspired by [LibreTube](https://github.com/libre-tube/LibreTube) —
no distracting algorithmic feeds, no recommendation loops, no trending. Just search, a high-quality adaptive player, SponsorBlock,
channel bookmarks with folders and tags, playlist management, and watch history.

Built with **Electron + Vite + React + TypeScript**, extracting data with
[`youtubei.js`](https://github.com/LuanRT/YouTube.js) and playing back adaptive streams with
[Shaka Player](https://github.com/shaka-project/shaka-player).

---

## Features

- **Search** — results across **videos, channels, playlists, and YouTube Music**, with
  All / Videos / Channels / Playlists / Music filter chips; live search suggestions; infinite
  scroll (continuation); **search history** with configurable storage limits, reuse, per-item delete, and clear-all.
- **Channels** — open any channel from search or the watch page: banner, avatar, handle and
  subscriber count; Videos / Playlists / About tabs; native server-side video sorting (Newest, Most popular, Oldest)
  and public channel playlists (openable as remote playlists).
- **Saved Channels & Recent Videos Feed** — bookmark channels into custom folders and tags/labels; browse an
  on-demand recent uploads feed filtered by folder, label, and recency window (past 24h, past week, past month).
- **High-quality player** — DASH adaptive streaming (up to 2160p) with a
  Material 3 Expressive control bar: play/pause, a full-width seek bar with buffered +
  SponsorBlock markers and hover time preview, volume with a live percentage readout, video
  quality, **audio track selection (original audio selected by default)** plus audio bitrate,
  captions (when available), Picture-in-Picture, fullscreen, and keyboard shortcuts. A playback
  sheet offers **speed presets + editable slider**, **preserve-pitch toggle**, and **Skip
  Silence** (real-time silence detection that speeds through quiet passages and restores when
  audio resumes). Every menu is an **adaptive popover** — it opens where there is room and
  closes on outside click or Escape.
- **Playlist Sidebar** — independent scrolling sidebar with its own isolated scroll container,
  automatic scroll-to-active item, and collapsible layout.
- **Video information** — title, channel avatar + name (clickable → channel page), views,
  publish date, description with its original line breaks, and **Return YouTube Dislike** counts.
- **SponsorBlock** — automatic skipping of sponsor/self-promo/interaction/intro/outro/preview/filler
  segments, with per-category toggles and an **Undo** toast when a segment is skipped.
- **Playlists — local and YouTube** — create/rename/delete local playlists, add/remove videos,
  reorder items, and play a whole playlist with an in-page queue. Any YouTube playlist can be
  **saved to the Playlists section**; it stays a live reference (name, count, and items re-synced
  from YouTube each time you open it, with a manual "Sync now" action) and can be copied into a
  local playlist.
- **History** — watch history is recorded automatically with a clear visual progress bar and resume position pill;
  searchable by title and author; configurable capacity limits (100–5000 entries); can be switched off and cleared
  in Settings.
- **Material 3 Expressive UI** — polished dark theme with seven accent palettes, springy motion,
  expressive rounded shapes, responsive layout, and carefully designed settings, menus, and dialogs.
- **Layout** — a **collapsible sidebar** (narrow icon rail when collapsed, remembered between
  launches), full-width content areas for search / channels / playlists / history / settings, filter chips
  that only appear once something is searched, and expandable video descriptions.

## How it works (architecture)

```
┌──────────────────────── Electron main process ─────────────────────────┐
│  youtubei.js (Innertube)            MediaProxy (127.0.0.1, random port) │
│   • search / suggestions             • /media   → Range/206 passthru    │
│   • getBasicInfo (VISIONOS client)   • /manifest→ generated DASH MPD    │
│   • toDash() → MPD                   • /captions→ json3 → WebVTT        │
│  Store (atomic JSON in userData)     SponsorBlock + ReturnYouTubeDislike│
└───────────────────────────────┬─────────────────────────────────────────┘
                     contextBridge (ipcRenderer.invoke)
┌───────────────────────────────┴─────────────────────────────────────────┐
│  React renderer: Search · Watch · Channels · Playlists · History        │
│  Shaka Player decodes the MPD served by the proxy                       │
└─────────────────────────────────────────────────────────────────────────┘
```

### Why no PO tokens / BotGuard?

YouTube requires a "proof of origin" (PO) token for many extraction paths, and desktop
clients often implement a full BotGuard flow to mint them. This app avoids that entire class of
complexity by extracting with the **`VISIONOS` innertube client**, which returns **direct, range-seekable
adaptive stream URLs** for every video and audio track without a PO token. Unlike the `IOS` client (which
restricts HTTP Range requests beyond the initial buffer), `VISIONOS` stream URLs support unrestricted
seeking across any byte range. All YouTube network access happens in the main process; the renderer only
ever talks to the local proxy (enforced by a strict Content-Security-Policy).

The local proxy exists because googlevideo stream URLs must be requested with a matching
`Referer`/`Origin`/`User-Agent`, and because the renderer needs a same-origin source for the generated
DASH manifest and caption tracks.

## Requirements

- Windows 10/11 (x64)
- Node.js 20+ and npm (for development/building)

## Development

```bash
npm install
npm run dev          # electron-vite dev server with hot reload
```

Other useful scripts:

```bash
npm run typecheck    # tsc for both the node (main/preload) and web (renderer) projects
npm run build        # build main, preload and renderer into out/
npm run preview      # preview the production build
npm run icon         # regenerate build/icon.png
```

## Packaging (Windows installer)

```bash
npm run dist         # build + NSIS installer → release/
npm run dist:dir     # build + unpacked app only (faster, no installer)
```

The installer is produced at `release/ViewFlux-Setup-<version>.exe`.

## Data & privacy

All state is stored **locally** in a single JSON file under Electron's `userData` directory
(`viewflux-data.json`, with automated migration from legacy `libretube-data.json`) — nothing is sent to any external server. Outbound requests are limited to
YouTube (for extraction/media), SponsorBlock, and Return YouTube Dislike.

## Known limitations

- Live streams are not supported (the `VISIONOS` client marks them unplayable); the UI reports this clearly.
- Captions depend on the video exposing caption tracks to the `VISIONOS` client; when none exist, the
  caption menu is hidden.

## License & attribution

Licensed under the **GNU General Public License v3.0 or later**.
Not affiliated with or endorsed by YouTube or Google. This is an independent, open-source client,
inspired by [LibreTube](https://github.com/libre-tube/LibreTube), [NewPipe](https://github.com/TeamNewPipe/NewPipe)
and [FreeTube](https://github.com/FreeTubeApp/FreeTube).
