/**
 * Zero-dependency implementation of YouTube's cold start PO Token generator.
 *
 * Cold start tokens use a lightweight XOR-encrypted packet with timestamp and
 * content binding (e.g. video ID). They can be generated instantaneously (<0.1ms)
 * without any DOM, external network calls, or BotGuard VM initialization, allowing
 * immediate video playback start before the full 12-hour BotGuard minter is ready.
 */

function toWebsafeBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '')
}

/**
 * Creates a cold start Proof of Origin token bound to a video ID or visitor ID.
 *
 * @param contentBinding The target videoId or visitorData
 * @param clientState Client state identifier (defaults to 1)
 */
export function createColdStartToken(contentBinding: string, clientState = 1): string {
  const contentBindingBytes = new TextEncoder().encode(contentBinding)
  const timestamp = Math.floor(Date.now() / 1000)
  const randomKeys = [Math.floor(Math.random() * 256), Math.floor(Math.random() * 256)]

  const header = [
    randomKeys[0],
    randomKeys[1],
    0,
    clientState & 0xff,
    (timestamp >> 24) & 0xff,
    (timestamp >> 16) & 0xff,
    (timestamp >> 8) & 0xff,
    timestamp & 0xff
  ]

  const packet = new Uint8Array(2 + header.length + contentBindingBytes.length)
  packet[0] = 34 // Magic packet identifier (0x22)
  packet[1] = header.length + contentBindingBytes.length
  packet.set(header, 2)
  packet.set(contentBindingBytes, 2 + header.length)

  const payload = packet.subarray(2)
  const keyLength = randomKeys.length
  for (let i = keyLength; i < payload.length; i++) {
    payload[i] ^= payload[i % keyLength]
  }

  return toWebsafeBase64(packet)
}
