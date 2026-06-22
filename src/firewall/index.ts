import { LunorClient } from '../client'
import { LUNOR_ENDPOINT } from '../constants'
import { SecurityType } from '../types'
import { BlocklistStore } from './store'
import { createExpressMiddleware, type ReportFn } from './express'

export interface FirewallOptions {
  client: LunorClient
  apiKey: string
  apiSecret: string
  /** Bazowy endpoint webhooka; blocklista wyprowadzana automatycznie. */
  endpoint?: string
  pollIntervalMs?: number
  /** Ścieżka snapshotu na dysku (tylko długo-żyjące procesy, np. Express). */
  snapshotPath?: string
}

function deriveBlocklistUrl(endpoint: string): string {
  if (endpoint.endsWith('/api/webhook')) {
    return endpoint.slice(0, -'/api/webhook'.length) + '/api/firewall/blocklist'
  }
  // Fallback: doklej ścieżkę do origin.
  try {
    const u = new URL(endpoint)
    return `${u.origin}/api/firewall/blocklist`
  } catch {
    return endpoint
  }
}

export function createFirewall(opts: FirewallOptions) {
  const endpoint = opts.endpoint ?? LUNOR_ENDPOINT
  const store = new BlocklistStore({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    blocklistUrl: deriveBlocklistUrl(endpoint),
    pollIntervalMs: opts.pollIntervalMs,
    snapshotPath: opts.snapshotPath,
  })

  const report: ReportFn = (kind, ip, matchedValue, req) => {
    opts.client.captureSecurityEvent({
      type:
        kind === 'FIREWALL_BLOCK'
          ? SecurityType.FIREWALL_BLOCK
          : SecurityType.FIREWALL_WOULD_BLOCK,
      ipAddress: ip,
      description:
        kind === 'FIREWALL_BLOCK'
          ? `Firewall: zablokowano ${ip} (reguła ${matchedValue})`
          : `Firewall (monitor): zablokowałoby ${ip} (reguła ${matchedValue})`,
      metadata: {
        matchedValue,
        method: req?.method,
        path: req?.originalUrl ?? req?.url,
      },
    })
  }

  return {
    store,
    express: () => createExpressMiddleware(store, report),
    start: () => store.start(),
    stop: () => store.stop(),
  }
}
