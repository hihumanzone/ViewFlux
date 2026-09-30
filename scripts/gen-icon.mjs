import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')
const OUT_ICO = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.ico')

const SIZE = 512
const SS = 4
const W = SIZE * SS

// Badge geometry
// 512 canvas, 20px margin -> 472px badge
const MARGIN = 20 * SS
const BADGE_SIZE = W - 2 * MARGIN
const HALF_BADGE = BADGE_SIZE / 2
// M3 squircle radius matching in-app ratio: 14px / 38px ≈ 0.3684
const BADGE_RADIUS = Math.round(BADGE_SIZE * (14 / 38))

const CX = W / 2
const CY = W / 2

// Exact SDF for rounded box
function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - (bx - r)
  const qy = Math.abs(py) - (by - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  const outsideDist = Math.hypot(ox, oy)
  const insideDist = Math.min(Math.max(qx, qy), 0)
  return outsideDist + insideDist - r
}

// Play triangle geometry:
// Triangle height is ~39.5% of badge size (186px on 512)
// Width is (11 / 14) * height (146px on 512)
// This matches the in-app enlarged play button (23px SVG in 38px badge)
const TRI_HEIGHT = BADGE_SIZE * 0.395
const TRI_WIDTH = TRI_HEIGHT * (11 / 14)

// Optical center alignment (centroid at CX):
// In Material Icons play_arrow (viewBox 0 0 24 24, path M8 5v14l11-7z):
// Base is at x=8, tip is at x=19, center of viewBox is x=12.
// Distance from base to center: 4 units. Distance from center to tip: 7 units.
const triBaseX = CX - TRI_WIDTH * (4 / 11)
const triTipX = triBaseX + TRI_WIDTH
const triTopY = CY - TRI_HEIGHT / 2
const triBottomY = CY + TRI_HEIGHT / 2

const p1 = { x: triBaseX, y: triTopY }
const p2 = { x: triBaseX, y: triBottomY }
const p3 = { x: triTipX, y: CY }

function sign(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
}

function insideTriangle(px, py, a, b, c) {
  const d1 = sign(px, py, a.x, a.y, b.x, b.y)
  const d2 = sign(px, py, b.x, b.y, c.x, c.y)
  const d3 = sign(px, py, c.x, c.y, a.x, a.y)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// Palette:
// --primary: #d0bcff [208, 188, 255]
// --primary-container: #4f378b [79, 55, 139]
// --on-primary: #381e72 [56, 30, 114]
const GRAD_START = [208, 188, 255]
const GRAD_END = [79, 55, 139]
const GLYPH_COLOR = [56, 30, 114]

console.log('Rendering 512x512 with 4x supersampling...')
const hi = Buffer.alloc(W * W * 4)

const minX = MARGIN
const minY = MARGIN

for (let y = 0; y < W; y++) {
  const py = y - CY
  for (let x = 0; x < W; x++) {
    const px = x - CX
    const i = (y * W + x) * 4

    // Distance to badge boundary
    const dBadge = sdRoundedBox(px, py, HALF_BADGE, HALF_BADGE, BADGE_RADIUS)

    if (dBadge <= 0) {
      // 135deg diagonal gradient: top-left (0) to bottom-right (1)
      const t = Math.max(0, Math.min(1, ((x - minX) + (y - minY)) / (2 * BADGE_SIZE)))
      const bgR = Math.round(GRAD_START[0] + (GRAD_END[0] - GRAD_START[0]) * t)
      const bgG = Math.round(GRAD_START[1] + (GRAD_END[1] - GRAD_START[1]) * t)
      const bgB = Math.round(GRAD_START[2] + (GRAD_END[2] - GRAD_START[2]) * t)

      const inGlyph = insideTriangle(x, y, p1, p2, p3)

      if (inGlyph) {
        hi[i] = GLYPH_COLOR[0]
        hi[i + 1] = GLYPH_COLOR[1]
        hi[i + 2] = GLYPH_COLOR[2]
        hi[i + 3] = 255
      } else {
        hi[i] = bgR
        hi[i + 1] = bgG
        hi[i + 2] = bgB
        hi[i + 3] = 255
      }
    }
    // Outside badge remains [0, 0, 0, 0] transparent
  }
}

// Downsample SSxSS -> SIZE with straight RGBA averaging
const out = Buffer.alloc(SIZE * SIZE * 4)
const area = SS * SS
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0, g = 0, b = 0, a = 0
    for (let sy = 0; sy < SS; sy++) {
      for (let sx = 0; sx < SS; sx++) {
        const i = ((y * SS + sy) * W + (x * SS + sx)) * 4
        const alpha = hi[i + 3]
        r += hi[i] * alpha
        g += hi[i + 1] * alpha
        b += hi[i + 2] * alpha
        a += alpha
      }
    }
    const o = (y * SIZE + x) * 4
    if (a === 0) continue
    out[o] = Math.round(r / a)
    out[o + 1] = Math.round(g / a)
    out[o + 2] = Math.round(b / a)
    out[o + 3] = Math.round(a / area)
  }
}

// Minimal PNG encoder
const crcTable = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const body = Buffer.concat([typeBuf, data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([len, body, crc])
}

function encodePng(rgba, size) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function downsampleRgba(srcRgba, srcSize, dstSize) {
  if (srcSize === dstSize) return srcRgba
  const dst = Buffer.alloc(dstSize * dstSize * 4)
  const scale = srcSize / dstSize

  for (let y = 0; y < dstSize; y++) {
    const y0 = Math.floor(y * scale)
    const y1 = Math.min(srcSize, Math.floor((y + 1) * scale))
    for (let x = 0; x < dstSize; x++) {
      const x0 = Math.floor(x * scale)
      const x1 = Math.min(srcSize, Math.floor((x + 1) * scale))

      let r = 0, g = 0, b = 0, a = 0, count = 0
      for (let sy = y0; sy < y1; sy++) {
        for (let sx = x0; sx < x1; sx++) {
          const i = (sy * srcSize + sx) * 4
          const alpha = srcRgba[i + 3]
          r += srcRgba[i] * alpha
          g += srcRgba[i + 1] * alpha
          b += srcRgba[i + 2] * alpha
          a += alpha
          count++
        }
      }
      const o = (y * dstSize + x) * 4
      if (a === 0 || count === 0) continue
      dst[o] = Math.round(r / a)
      dst[o + 1] = Math.round(g / a)
      dst[o + 2] = Math.round(b / a)
      dst[o + 3] = Math.round(a / count)
    }
  }
  return dst
}

function buildIco(layers) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(layers.length, 4)

  let offset = 6 + layers.length * 16
  const dirEntries = []
  for (const layer of layers) {
    const entry = Buffer.alloc(16)
    entry.writeUInt8(layer.size === 256 ? 0 : layer.size, 0)
    entry.writeUInt8(layer.size === 256 ? 0 : layer.size, 1)
    entry.writeUInt8(0, 2)
    entry.writeUInt8(0, 3)
    entry.writeUInt16LE(1, 4)
    entry.writeUInt16LE(32, 6)
    entry.writeUInt32LE(layer.png.length, 8)
    entry.writeUInt32LE(offset, 12)
    dirEntries.push(entry)
    offset += layer.png.length
  }
  return Buffer.concat([header, ...dirEntries, ...layers.map((l) => l.png)])
}

mkdirSync(dirname(OUT), { recursive: true })

// 1. Write master 512x512 PNG
const png = encodePng(out, SIZE)
writeFileSync(OUT, png)
console.log(`Wrote ${OUT} (${png.length} bytes)`)

// 2. Generate multi-resolution Windows ICO container (256, 128, 64, 48, 32, 24, 16)
const icoSizes = [256, 128, 64, 48, 32, 24, 16]
const icoLayers = icoSizes.map((sz) => {
  const downsampled = downsampleRgba(out, SIZE, sz)
  return { size: sz, png: encodePng(downsampled, sz) }
})
const ico = buildIco(icoLayers)
writeFileSync(OUT_ICO, ico)
console.log(`Wrote ${OUT_ICO} (${ico.length} bytes with sizes: ${icoSizes.join(', ')})`)

// 3. Generate NSIS installer bitmaps on Windows
if (process.platform === 'win32') {
  try {
    const psScript = resolve(dirname(fileURLToPath(import.meta.url)), 'gen-installer-bitmaps.ps1')
    const { execSync } = await import('node:child_process')
    execSync(`powershell -ExecutionPolicy Bypass -File "${psScript}"`, { stdio: 'inherit' })
  } catch (err) {
    console.warn('Could not generate installer bitmaps:', err.message)
  }
}
