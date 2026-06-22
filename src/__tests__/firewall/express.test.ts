import { describe, it, expect, vi } from 'vitest'
import { createExpressMiddleware } from '../../firewall/express'

function fakeStore(state: any) {
  return { getState: () => state } as any
}
function mkReqRes(ip: string) {
  const req = { headers: { 'x-forwarded-for': ip }, socket: {} }
  const res: any = { statusCode: 0, body: null }
  res.status = (c: number) => { res.statusCode = c; return res }
  res.json = (b: any) => { res.body = b; return res }
  return { req, res }
}

describe('createExpressMiddleware', () => {
  it('OFF: zawsze next, brak raportu', () => {
    const report = vi.fn()
    const mw = createExpressMiddleware(fakeStore({ mode: 'OFF', entries: [{ type: 'IP', value: '1.2.3.4' }] }), report)
    const { req, res } = mkReqRes('1.2.3.4')
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(report).not.toHaveBeenCalled()
  })

  it('cold start (state=null): next', () => {
    const mw = createExpressMiddleware(fakeStore(null), vi.fn())
    const { req, res } = mkReqRes('1.2.3.4')
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('MONITOR + match: raport WOULD_BLOCK, ale przepuszcza', () => {
    const report = vi.fn()
    const mw = createExpressMiddleware(fakeStore({ mode: 'MONITOR', entries: [{ type: 'IP', value: '1.2.3.4' }] }), report)
    const { req, res } = mkReqRes('::ffff:1.2.3.4')
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalled()
    expect(report).toHaveBeenCalledWith('FIREWALL_WOULD_BLOCK', '1.2.3.4', '1.2.3.4', req)
  })

  it('ENFORCE + match: 403, brak next, raport BLOCK', () => {
    const report = vi.fn()
    const mw = createExpressMiddleware(fakeStore({ mode: 'ENFORCE', entries: [{ type: 'IP', value: '1.2.3.4' }] }), report)
    const { req, res } = mkReqRes('1.2.3.4')
    const next = vi.fn()
    mw(req, res, next)
    expect(next).not.toHaveBeenCalled()
    expect(res.statusCode).toBe(403)
    expect(report).toHaveBeenCalledWith('FIREWALL_BLOCK', '1.2.3.4', '1.2.3.4', req)
  })

  it('ENFORCE + brak matcha: next', () => {
    const mw = createExpressMiddleware(fakeStore({ mode: 'ENFORCE', entries: [{ type: 'IP', value: '9.9.9.9' }] }), vi.fn())
    const { req, res } = mkReqRes('1.2.3.4')
    const next = vi.fn()
    mw(req, res, next)
    expect(next).toHaveBeenCalled()
  })

  it('izolant: wyjątek w report nie blokuje (fail-open) w MONITOR', () => {
    const report = vi.fn(() => { throw new Error('boom') })
    const mw = createExpressMiddleware(fakeStore({ mode: 'MONITOR', entries: [{ type: 'IP', value: '1.2.3.4' }] }), report)
    const { req, res } = mkReqRes('1.2.3.4')
    const next = vi.fn()
    expect(() => mw(req, res, next)).not.toThrow()
    expect(next).toHaveBeenCalled()
  })
})
