import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { BlocklistStore } from '../../firewall/store'

function okResponse(body: any, etag = '"e1"') {
  return {
    ok: true,
    status: 200,
    headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? etag : null) },
    json: async () => body,
  }
}
function notModified(etag = '"e1"') {
  return { ok: false, status: 304, headers: { get: () => etag }, json: async () => ({}) }
}

const baseOpts = {
  apiKey: 'k',
  apiSecret: 's',
  blocklistUrl: 'https://x/api/firewall/blocklist',
  logger: () => {},
}

beforeEach(() => vi.restoreAllMocks())
afterEach(() => vi.restoreAllMocks())

describe('BlocklistStore', () => {
  it('zimny start: getState() = null przed pierwszym pobraniem', () => {
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: vi.fn() as any })
    expect(store.getState()).toBeNull()
  })

  it('refreshOnce wczytuje stan z odpowiedzi 200', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      okResponse({ mode: 'ENFORCE', entries: [{ type: 'IP', value: '1.2.3.4', expiresAt: null }] }),
    )
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: fetchImpl as any })
    await store.refreshOnce()
    expect(store.getState()?.mode).toBe('ENFORCE')
    expect(store.getState()?.entries).toHaveLength(1)
  })

  it('304 zachowuje poprzedni stan i wysyła If-None-Match', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ mode: 'MONITOR', entries: [] }, '"e1"'))
      .mockResolvedValueOnce(notModified('"e1"'))
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: fetchImpl as any })
    await store.refreshOnce()
    await store.refreshOnce()
    expect(store.getState()?.mode).toBe('MONITOR')
    const secondHeaders = fetchImpl.mock.calls[1][1].headers
    expect(secondHeaders['If-None-Match']).toBe('"e1"')
  })

  it('fail-open: błąd sieci nie rzuca i zachowuje poprzedni stan', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(okResponse({ mode: 'ENFORCE', entries: [] }))
      .mockRejectedValueOnce(new Error('network down'))
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: fetchImpl as any })
    await store.refreshOnce()
    await expect(store.refreshOnce()).resolves.toBeUndefined()
    expect(store.getState()?.mode).toBe('ENFORCE')
  })

  it('zimny start + błąd: getState pozostaje null (brak ochrony, fail-open)', async () => {
    const fetchImpl = vi.fn().mockRejectedValue(new Error('down'))
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: fetchImpl as any })
    await store.refreshOnce()
    expect(store.getState()).toBeNull()
  })

  it('wysyła nagłówki auth X-API-Key + podpis', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(okResponse({ mode: 'OFF', entries: [] }))
    const store = new BlocklistStore({ ...baseOpts, fetchImpl: fetchImpl as any })
    await store.refreshOnce()
    const headers = fetchImpl.mock.calls[0][1].headers
    expect(headers['X-API-Key']).toBe('k')
    expect(headers['X-Lunor-Signature']).toMatch(/^v1=/)
  })
})
