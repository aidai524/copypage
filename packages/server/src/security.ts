import { createHash, timingSafeEqual } from 'node:crypto'
import dns from 'node:dns/promises'
import { isIP } from 'node:net'

export class SecurityError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SecurityError'
  }
}

/** Constant-time token check (hashed so lengths always match). */
export function tokenMatches(provided: string, expected: string): boolean {
  const a = createHash('sha256').update(provided).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.')
  if (parts.length !== 4) return null
  let n = 0
  for (const p of parts) {
    const v = Number(p)
    if (!Number.isInteger(v) || v < 0 || v > 255 || p === '') return null
    n = n * 256 + v
  }
  return n >>> 0
}

const V4_BLOCKS: [number, number][] = [
  [0x00000000, 8], // 0.0.0.0/8
  [0x0a000000, 8], // 10/8
  [0x64400000, 10], // 100.64/10 CGNAT
  [0x7f000000, 8], // 127/8
  [0xa9fe0000, 16], // 169.254/16 link-local (cloud metadata)
  [0xac100000, 12], // 172.16/12
  [0xc0000000, 24], // 192.0.0/24
  [0xc0000200, 24], // 192.0.2/24
  [0xc0a80000, 16], // 192.168/16
  [0xc6120000, 15], // 198.18/15
  [0xc6336400, 24], // 198.51.100/24
  [0xcb007100, 24], // 203.0.113/24
  [0xe0000000, 4], // 224/4 multicast
  [0xf0000000, 4], // 240/4 reserved
]

function isPrivateV4(n: number): boolean {
  return V4_BLOCKS.some(([block, bits]) => (n >>> (32 - bits)) === (block >>> (32 - bits)))
}

function expandIpv6(ip: string): bigint | null {
  let s = ip
  const zone = s.indexOf('%')
  if (zone >= 0) s = s.slice(0, zone)

  const lastColon = s.lastIndexOf(':')
  const tail = s.slice(lastColon + 1)
  if (tail.includes('.')) {
    const v4 = ipv4ToInt(tail)
    if (v4 === null) return null
    const hi = ((v4 >>> 16) & 0xffff).toString(16)
    const lo = (v4 & 0xffff).toString(16)
    s = `${s.slice(0, lastColon + 1)}${hi}:${lo}`
  }

  const halves = s.split('::')
  if (halves.length > 2) return null
  const head = halves[0] ? halves[0].split(':') : []
  const rest = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : []
  const missing = 8 - head.length - rest.length
  if (missing < 0) return null
  if (halves.length === 1 && missing !== 0) return null
  const groups = halves.length === 2 ? [...head, ...Array(missing).fill('0'), ...rest] : head
  if (groups.length !== 8) return null

  let value = 0n
  for (const g of groups) {
    if (!/^[0-9a-f]{1,4}$/i.test(g)) return null
    value = (value << 16n) | BigInt(parseInt(g, 16))
  }
  return value
}

const V6_BLOCKS: [bigint, number][] = [
  [0x0n, 128], // ::
  [0x1n, 128], // ::1
  [0xfc00n << 112n, 7], // unique local
  [0xfe80n << 112n, 10], // link local
  [0xff00n << 112n, 8], // multicast
  [0x20010db8n << 96n, 32], // documentation
]

/** True for loopback/private/link-local/multicast/reserved addresses. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 4) return isPrivateV4(ipv4ToInt(ip)!)
  if (family === 6) {
    const value = expandIpv6(ip)
    if (value === null) return true
    // IPv4-mapped ::ffff:0:0/96 → check the embedded IPv4
    if (value >> 32n === 0xffffn) return isPrivateV4(Number(value & 0xffffffffn))
    for (const [block, bits] of V6_BLOCKS) {
      if (value >> BigInt(128 - bits) === block >> BigInt(128 - bits)) return true
    }
    return false
  }
  return true // not an IP at all: treat as unsafe
}

/**
 * SSRF guard for user-supplied capture URLs: http(s) only, and every resolved
 * address must be public. NOTE: this validates at submit time; the browser
 * resolves again when loading. True protection against DNS rebinding needs
 * egress filtering at the network layer (documented in README).
 */
export async function assertPublicUrl(
  raw: string,
  opts: { allowPrivateNetwork?: boolean } = {},
): Promise<URL> {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new SecurityError('invalid URL')
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SecurityError('only http/https URLs can be captured')
  }
  if (opts.allowPrivateNetwork) return url

  const host = url.hostname.replace(/^\[|\]$/g, '')
  let addresses: string[]
  if (isIP(host)) {
    addresses = [host]
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true })).map((a) => a.address)
    } catch {
      throw new SecurityError(`cannot resolve host: ${host}`)
    }
  }
  for (const address of addresses) {
    if (isPrivateAddress(address)) {
      throw new SecurityError(`blocked non-public address for ${host}: ${address}`)
    }
  }
  return url
}
