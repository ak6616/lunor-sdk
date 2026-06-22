import type { BlocklistStore } from './store'
import { matchBlocklist, normalizeIp } from './matcher'

export type ReportFn = (
  kind: 'FIREWALL_BLOCK' | 'FIREWALL_WOULD_BLOCK',
  ip: string,
  matchedValue: string,
  req: any,
) => void

function defaultGetIp(req: any): string {
  const xff = req?.headers?.['x-forwarded-for']
  if (typeof xff === 'string' && xff.length) return xff.split(',')[0].trim()
  const xri = req?.headers?.['x-real-ip']
  if (typeof xri === 'string' && xri.length) return xri
  return req?.ip || req?.socket?.remoteAddress || 'unknown'
}

export function createExpressMiddleware(
  store: BlocklistStore,
  report: ReportFn,
  getIp: (req: any) => string = defaultGetIp,
) {
  return function lunorFirewall(req: any, res: any, next: any): void {
    try {
      const state = store.getState()
      if (!state || state.mode === 'OFF') return next()

      const ip = normalizeIp(getIp(req))
      const matched = matchBlocklist(ip, state.entries)
      if (!matched) return next()

      if (state.mode === 'MONITOR') {
        safeReport(report, 'FIREWALL_WOULD_BLOCK', ip, matched.value, req)
        return next()
      }

      // ENFORCE
      safeReport(report, 'FIREWALL_BLOCK', ip, matched.value, req)
      res.status(403).json({ error: 'Forbidden' })
    } catch (err) {
      // Twardy izolant: firewall nie może wywalić ani zablokować aplikacji.
      console.warn('[Lunor firewall] middleware error (fail-open):', err)
      try {
        next()
      } catch {
        /* next i tak rzucił — nic więcej nie zrobimy */
      }
    }
  }
}

function safeReport(report: ReportFn, kind: any, ip: string, value: string, req: any): void {
  try {
    report(kind, ip, value, req)
  } catch (err) {
    console.warn('[Lunor firewall] report error (ignoruję):', err)
  }
}
