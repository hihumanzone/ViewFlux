// Generates build/icon.png (512x512) with no third-party dependencies.
// A rounded-square purple gradient badge with a play glyph — matching LibreTube's
// brand. electron-builder converts this PNG into the Windows .ico automatically.
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const OUT = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'build', 'icon.png')

const SIZE = 512
const SS = 4 // supersampling factor for anti-aliasing
const W = SIZE * SS

// --- geometry helpers (in supersampled space) ---
const margin = 22 * SS
const radius = 116 * SS
const minX = margin
const maxX = W - margin
const minY = margin
const maxY = W - margin

function insideRoundedRect(x, y) {
  const cx = Math.min(Math.max(x, minX + radius), maxX - radius)
  const cy = Math.min(Math.max(y, minY + radius), maxY - radius)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= radius * radius
}

function sign(ax, ay, bx, by, cx, cy) {
  return (ax - cx) * (by - cy) - (bx - cx) * (ay - cy)
}
function insideTriangle(px, py, ax, ay, bx, by, cx, cy) {
  const d1 = sign(px, py, ax, ay, bx, by)
  const d2 = sign(px, py, bx, by, cx, cy)
  const d3 = sign(px, py, cx, cy, ax, ay)
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

// Play glyph (pointing right), centered.
const tri = {
  ax: 188 * SS,
  ay: 148 * SS,
  bx: 188 * SS,
  by: 364 * SS,
  cx: 356 * SS,
  cy: 256 * SS
}

const top = [167, 139, 250]
const bottom = [91, 61, 158]
const glyph = [246, 242, 255]

const hi = Buffer.alloc(W * W * 4)
for (let y = 0; y < W; y++) {
  const t = y / (W - 1)
  const bg = [
    Math.round(top[0] + (bottom[0] - top[0]) * t),
    Math.round(top[1] + (bottom[1] - top[1]) * t),
    Math.round(top[2] + (bottom[2] - top[2]) * t)
  ]
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4
    if (!insideRoundedRect(x + 0.5, y + 0.5)) continue
    const inGlyph = insideTriangle(x + 0.5, y + 0.5, tri.ax, tri.ay, tri.bx, tri.by, tri.cx, tri.cy)
    const c = inGlyph ? glyph : bg
    hi[i] = c[0]
    hi[i + 1] = c[1]
    hi[i + 2] = c[2]
    hi[i + 3] = 255
  }
}

// Box-downsample SSxSS -> SIZE, averaging straight (non-premultiplied) RGBA.
const out = Buffer.alloc(SIZE * SIZE * 4)
const area = SS * SS
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    let r = 0
    let g = 0
    let b = 0
    let a = 0
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

// --- minimal PNG encoder (RGBA, 8-bit) ---
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

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // colour type: RGBA
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0 // filter: none
  out.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

mkdirSync(dirname(OUT), { recursive: true })
writeFileSync(OUT, png)
console.log(`Wrote ${OUT} (${png.length} bytes)`)
