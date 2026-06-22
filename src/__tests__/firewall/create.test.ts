import { describe, it, expect, vi } from 'vitest'
import { createFirewall } from '../../firewall'

function fakeClient() {
  return { captureSecurityEvent: vi.fn() } as any
}

describe('createFirewall', () => {
  it('wyprowadza URL blocklisty z endpointu webhooka', () => {
    const fw = createFirewall({
      client: fakeClient(),
      apiKey: 'k',
      apiSecret: 's',
      endpoint: 'https://www.lunor.com.pl/api/webhook',
    })
    expect((fw.store as any).opts.blocklistUrl).toBe('https://www.lunor.com.pl/api/firewall/blocklist')
  })

  it('zwraca middleware (funkcję 3-argumentową)', () => {
    const fw = createFirewall({ client: fakeClient(), apiKey: 'k', apiSecret: 's' })
    const mw = fw.express()
    expect(typeof mw).toBe('function')
    expect(mw.length).toBe(3)
  })

  it('raport idzie przez client.captureSecurityEvent', () => {
    const client = fakeClient()
    const fw = createFirewall({ client, apiKey: 'k', apiSecret: 's' })
    ;(fw.store as any).state = { mode: 'ENFORCE', entries: [{ type: 'IP', value: '1.2.3.4' }], fetchedAt: Date.now() }
    const mw = fw.express()
    const req = { headers: { 'x-forwarded-for': '1.2.3.4' }, socket: {}, originalUrl: '/x' }
    const res: any = { status: () => res, json: () => res }
    mw(req, res, () => {})
    expect(client.captureSecurityEvent).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'FIREWALL_BLOCK', ipAddress: '1.2.3.4' }),
    )
  })
})
