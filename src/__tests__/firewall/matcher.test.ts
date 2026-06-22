import { describe, it, expect } from 'vitest'
import { normalizeIp, matchBlocklist } from '../../firewall/matcher'

describe('normalizeIp', () => {
  it('zdejmuje ::ffff:', () => expect(normalizeIp('::ffff:1.2.3.4')).toBe('1.2.3.4'))
  it('goły IPv4 bez zmian', () => expect(normalizeIp('1.2.3.4')).toBe('1.2.3.4'))
})

describe('matchBlocklist', () => {
  it('trafia IP exact (po normalizacji ::ffff:)', () => {
    const m = matchBlocklist('::ffff:1.2.3.4', [{ type: 'IP', value: '1.2.3.4' }])
    expect(m?.value).toBe('1.2.3.4')
  })
  it('nie trafia gdy IP spoza listy', () => {
    expect(matchBlocklist('9.9.9.9', [{ type: 'IP', value: '1.2.3.4' }])).toBeNull()
  })
  it('trafia IPv4 w zakresie CIDR', () => {
    const m = matchBlocklist('45.198.224.244', [{ type: 'CIDR', value: '45.198.224.0/24' }])
    expect(m?.value).toBe('45.198.224.0/24')
  })
  it('nie trafia IPv4 spoza zakresu CIDR', () => {
    expect(matchBlocklist('45.198.225.1', [{ type: 'CIDR', value: '45.198.224.0/24' }])).toBeNull()
  })
  it('pomija wygasły wpis', () => {
    const past = new Date(Date.now() - 1000).toISOString()
    expect(matchBlocklist('1.2.3.4', [{ type: 'IP', value: '1.2.3.4', expiresAt: past }])).toBeNull()
  })
  it('honoruje niewygasły wpis', () => {
    const future = new Date(Date.now() + 60000).toISOString()
    const m = matchBlocklist('1.2.3.4', [{ type: 'IP', value: '1.2.3.4', expiresAt: future }])
    expect(m?.value).toBe('1.2.3.4')
  })
  it('pomija ASN w MVP', () => {
    expect(matchBlocklist('1.2.3.4', [{ type: 'ASN', value: 'AS206264' }])).toBeNull()
  })
})
