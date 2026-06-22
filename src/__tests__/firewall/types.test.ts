import { describe, it, expect } from 'vitest'
import { SecurityType } from '../../types'

describe('SecurityType — wartości firewalla', () => {
  it('ma FIREWALL_BLOCK', () => {
    expect(SecurityType.FIREWALL_BLOCK).toBe('FIREWALL_BLOCK')
  })
  it('ma FIREWALL_WOULD_BLOCK', () => {
    expect(SecurityType.FIREWALL_WOULD_BLOCK).toBe('FIREWALL_WOULD_BLOCK')
  })
})
