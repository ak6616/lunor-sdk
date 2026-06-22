// Dopasowanie IP do blocklisty. Bezzależnościowo: IPv4 CIDR liczone całkowitymi.
// IPv6 CIDR i ASN są poza MVP (IPv6 obsługiwany tylko jako exact).

const IPV4_RE = /^\d{1,3}(\.\d{1,3}){3}$/

export function normalizeIp(raw: string): string {
  const s = (raw ?? '').trim().toLowerCase()
  if (s.startsWith('::ffff:')) {
    const rest = s.slice(7)
    if (IPV4_RE.test(rest)) return rest
  }
  return s
}

export interface BlockEntryLite {
  type: string
  value: string
  expiresAt?: string | null
}

function ipv4ToInt(ip: string): number | null {
  if (!IPV4_RE.test(ip)) return null
  const parts = ip.split('.')
  let n = 0
  for (const p of parts) {
    const o = Number(p)
    if (!Number.isInteger(o) || o < 0 || o > 255) return null
    n = (n << 8) | o
  }
  return n >>> 0
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const [net, lenStr] = cidr.split('/')
  const len = Number(lenStr)
  if (!Number.isInteger(len) || len < 0 || len > 32) return false
  const ipInt = ipv4ToInt(ip)
  const netInt = ipv4ToInt(net)
  if (ipInt === null || netInt === null) return false
  if (len === 0) return true
  const mask = (0xffffffff << (32 - len)) >>> 0
  return (ipInt & mask) === (netInt & mask)
}

function notExpired(entry: BlockEntryLite, now: Date): boolean {
  if (!entry.expiresAt) return true
  const t = Date.parse(entry.expiresAt)
  return Number.isNaN(t) || t > now.getTime()
}

export function matchBlocklist(
  rawIp: string,
  entries: BlockEntryLite[],
  now: Date = new Date(),
): BlockEntryLite | null {
  const ip = normalizeIp(rawIp)
  if (!ip || ip === 'unknown') return null

  for (const entry of entries) {
    if (!notExpired(entry, now)) continue
    if (entry.type === 'IP') {
      if (normalizeIp(entry.value) === ip) return entry
    } else if (entry.type === 'CIDR') {
      if (entry.value.includes('/') && IPV4_RE.test(entry.value.split('/')[0])) {
        if (ipv4InCidr(ip, entry.value)) return entry
      }
      // IPv6 CIDR — poza MVP, pomijane
    }
    // ASN — poza MVP, pomijane
  }
  return null
}
