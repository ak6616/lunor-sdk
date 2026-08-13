import { describe, it, expect } from 'vitest'
import { decide, jitterMinutes, MIN_RETRY_MINUTES } from '../../backup/scheduler'
import { EMPTY_STATE } from '../../backup/state'
import type { BackupConfig } from '../../backup/types'

const cfg = (over: Partial<BackupConfig> = {}): BackupConfig => ({
  enabled: true,
  intervalHours: 24,
  preferredHourUtc: 2,
  maxSizeMb: 500,
  runNowRequestedAt: null,
  encryptionKeyFingerprint: null,
  ...over,
})

const SEED = 'key_abc'
const at = (iso: string) => new Date(iso)
const hoursAgo = (from: Date, h: number) => new Date(from.getTime() - h * 3_600_000).toISOString()

describe('decide — warunki blokujące', () => {
  it('brak konfiguracji → nie uruchamia', () => {
    const d = decide({ config: null, state: EMPTY_STATE, now: at('2026-08-08T02:10:00Z'), seed: SEED })
    expect(d.run).toBe(false)
  })

  it('backupy wyłączone → nie uruchamia', () => {
    const d = decide({
      config: cfg({ enabled: false }),
      state: EMPTY_STATE,
      now: at('2026-08-08T02:10:00Z'),
      seed: SEED,
    })
    expect(d.run).toBe(false)
  })

  it('wyłączone ma pierwszeństwo nad żądaniem z panelu', () => {
    const d = decide({
      config: cfg({ enabled: false, runNowRequestedAt: '2026-08-08T01:00:00Z' }),
      state: EMPTY_STATE,
      now: at('2026-08-08T02:10:00Z'),
      seed: SEED,
    })
    expect(d.run).toBe(false)
  })
})

describe('decide — pierwszy backup', () => {
  it('brak jakiejkolwiek kopii → uruchamia natychmiast, nie czeka na okno', () => {
    // 14:00 UTC to daleko od preferowanej 2:00 — i tak ma pójść.
    const d = decide({ config: cfg(), state: EMPTY_STATE, now: at('2026-08-08T14:00:00Z'), seed: SEED })
    expect(d.run).toBe(true)
    if (d.run) expect(d.trigger).toBe('SCHEDULED')
  })
})

describe('decide — interwał', () => {
  const now = at('2026-08-08T02:10:00Z')

  it('interwał nie minął → nie uruchamia', () => {
    const d = decide({
      config: cfg(),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(now, 3) },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(false)
  })

  it('interwał minął i jesteśmy w oknie → uruchamia', () => {
    const jitter = jitterMinutes(SEED)
    const windowNow = new Date(Date.UTC(2026, 7, 8, 2, 0, 0) + jitter * 60_000 + 60_000)
    const d = decide({
      config: cfg(),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(windowNow, 30) },
      now: windowNow,
      seed: SEED,
    })
    expect(d.run).toBe(true)
  })

  it('interwał minął, ale poza oknem → czeka', () => {
    const noon = at('2026-08-08T12:00:00Z')
    const d = decide({
      config: cfg(),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(noon, 25) },
      now: noon,
      seed: SEED,
    })
    expect(d.run).toBe(false)
    expect(d.reason).toContain('oknem')
  })

  it('po podwójnym interwale idzie niezależnie od godziny (lepiej o złej porze niż wcale)', () => {
    const noon = at('2026-08-08T12:00:00Z')
    const d = decide({
      config: cfg(),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(noon, 49) },
      now: noon,
      seed: SEED,
    })
    expect(d.run).toBe(true)
  })

  it('przy interwale < 24 h okno godzinowe NIE obowiązuje', () => {
    const noon = at('2026-08-08T12:00:00Z')
    const d = decide({
      config: cfg({ intervalHours: 6 }),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(noon, 7) },
      now: noon,
      seed: SEED,
    })
    expect(d.run).toBe(true)
  })
})

describe('decide — „uruchom teraz" z panelu', () => {
  const now = at('2026-08-08T12:00:00Z')

  it('nieobsłużone żądanie → uruchamia jako MANUAL, ignorując interwał i okno', () => {
    const d = decide({
      config: cfg({ runNowRequestedAt: '2026-08-08T11:59:00Z' }),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(now, 1) },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(true)
    if (d.run) expect(d.trigger).toBe('MANUAL')
  })

  it('to samo żądanie po obsłużeniu NIE uruchamia ponownie (restart agenta)', () => {
    const stamp = '2026-08-08T11:59:00Z'
    const d = decide({
      config: cfg({ runNowRequestedAt: stamp }),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(now, 1), handledRunNowAt: stamp },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(false)
  })

  it('nowe żądanie po poprzednim → uruchamia', () => {
    const d = decide({
      config: cfg({ runNowRequestedAt: '2026-08-08T11:59:00Z' }),
      state: { ...EMPTY_STATE, lastSuccessAt: hoursAgo(now, 1), handledRunNowAt: '2026-08-07T09:00:00Z' },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(true)
  })
})

describe('decide — bufor przed pętlą retry', () => {
  const now = at('2026-08-08T02:10:00Z')

  it('świeża nieudana próba wstrzymuje kolejną', () => {
    const d = decide({
      config: cfg(),
      state: { ...EMPTY_STATE, lastAttemptAt: new Date(now.getTime() - 60_000).toISOString() },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(false)
    expect(d.reason).toContain('niedawna')
  })

  it('po upływie buforu próbuje ponownie', () => {
    const d = decide({
      config: cfg(),
      state: {
        ...EMPTY_STATE,
        lastAttemptAt: new Date(now.getTime() - (MIN_RETRY_MINUTES + 1) * 60_000).toISOString(),
      },
      now,
      seed: SEED,
    })
    expect(d.run).toBe(true)
  })
})

describe('jitterMinutes', () => {
  it('jest deterministyczny — restart nie przesuwa okna', () => {
    expect(jitterMinutes('abc')).toBe(jitterMinutes('abc'))
  })

  it('mieści się w 0–59', () => {
    for (const s of ['a', 'bb', 'key_1', 'key_2', 'zzzzzz']) {
      const j = jitterMinutes(s)
      expect(j).toBeGreaterThanOrEqual(0)
      expect(j).toBeLessThan(60)
    }
  })

  it('różne projekty dostają różne okna (rozpraszanie)', () => {
    const values = new Set(['k1', 'k2', 'k3', 'k4', 'k5'].map(jitterMinutes))
    expect(values.size).toBeGreaterThan(1)
  })
})
