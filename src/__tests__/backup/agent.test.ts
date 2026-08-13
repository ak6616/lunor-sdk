import { describe, it, expect, vi, beforeEach } from 'vitest'
import { Readable } from 'node:stream'
import { randomBytes } from 'node:crypto'
import { createBackup } from '../../backup'
import type { DumpEngine } from '../../backup/types'

const KEY = 'a'.repeat(64)

const CONFIG = {
  enabled: true,
  intervalHours: 24,
  preferredHourUtc: 2,
  maxSizeMb: 500,
  runNowRequestedAt: null,
  encryptionKeyFingerprint: null,
}

function jsonRes(body: unknown, status = 200, etag?: string) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'etag' ? (etag ?? null) : null) },
    json: async () => body,
  } as unknown as Response
}

/** Silnik atrapowy — zamiast pg_dump wypuszcza podane bajty. */
function fakeEngine(payload = 'SQL DUMP', opts: { fail?: boolean } = {}): DumpEngine {
  return {
    label: 'fake/gzip/aes-256-gcm',
    start() {
      return {
        stream: Readable.from([Buffer.from(payload)]),
        done: opts.fail ? Promise.reject(new Error('pg_dump exit 1')) : Promise.resolve(),
        abort: () => {},
      }
    },
  }
}

/** Routuje wywołania po ścieżce; zbiera je do inspekcji. */
function makeFetch(handlers: Record<string, (url: string, init?: RequestInit) => Response | Promise<Response>>) {
  const calls: Array<{ url: string; method: string }> = []
  const impl = vi.fn(async (input: unknown, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, method: init?.method ?? 'GET' })
    for (const [frag, h] of Object.entries(handlers)) {
      if (url.includes(frag)) return h(url, init)
    }
    throw new Error(`brak atrapy dla ${url}`)
  })
  return { impl: impl as unknown as typeof fetch, calls }
}

const baseOpts = {
  apiKey: 'k',
  apiSecret: 's',
  endpoint: 'https://lunor.test/api/webhook',
  encryptionKey: KEY,
  logger: () => {},
}

beforeEach(() => vi.restoreAllMocks())

describe('createBackup — moduł opt-in', () => {
  it('bez apiKey/apiSecret jest NIEAKTYWNY i nie robi I/O', async () => {
    const { impl, calls } = makeFetch({})
    const agent = createBackup({ ...baseOpts, apiKey: '', fetchImpl: impl, engine: fakeEngine() })
    expect(agent.enabled).toBe(false)
    agent.start()
    await agent.tick()
    expect(calls).toHaveLength(0)
  })

  it('bez databaseUrl i bez silnika jest nieaktywny', () => {
    const agent = createBackup({ ...baseOpts, engine: undefined })
    expect(agent.enabled).toBe(false)
  })

  it('🔴 bez encryptionKey ODMAWIA startu — nigdy nie wysyła plaintextu', async () => {
    const { impl, calls } = makeFetch({})
    const agent = createBackup({
      ...baseOpts,
      encryptionKey: undefined,
      fetchImpl: impl,
      engine: fakeEngine(),
    })
    expect(agent.enabled).toBe(false)
    await agent.tick()
    expect(calls).toHaveLength(0)
  })

  it('odrzuca klucz w złym formacie', () => {
    const agent = createBackup({ ...baseOpts, encryptionKey: 'zz', engine: fakeEngine() })
    expect(agent.enabled).toBe(false)
  })
})

describe('createBackup — pełny przebieg', () => {
  it('start → upload → meldunek UPLOADED z rozmiarem i checksumem', async () => {
    let patched: any = null
    const { impl } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG, 200, '"e1"'),
      '/api/backup/runs/r1': (_u, init) => {
        patched = JSON.parse(String(init?.body))
        return jsonRes({ status: 'VERIFIED', changed: true })
      },
      '/api/backup/runs': () =>
        jsonRes({
          runId: 'r1',
          uploadUrl: 'https://storage.test/put/r1',
          storagePath: 'p/r1.enc',
          expiresInSeconds: 900,
          maxSizeMb: 500,
        }, 201),
      'storage.test/put': () => jsonRes({}, 200),
    })

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()

    expect(patched).toBeTruthy()
    expect(patched.status).toBe('UPLOADED')
    expect(patched.sizeBytes).toBeGreaterThan(36) // magia + IV + authTag
    expect(patched.checksum).toMatch(/^[0-9a-f]{64}$/)
  })

  it('wysyła X-API-Key i podpis HMAC, ale NIGDY apiSecret', async () => {
    const seen: Record<string, string>[] = []
    const impl = vi.fn(async (_u: unknown, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>)
      return jsonRes(CONFIG, 200)
    }) as unknown as typeof fetch

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()

    expect(seen[0]['X-API-Key']).toBe('k')
    expect(seen[0]['X-Lunor-Signature']).toMatch(/^v1=[0-9a-f]{64}$/)
    expect(seen[0]['X-Lunor-Timestamp']).toMatch(/^\d+$/)
    expect(JSON.stringify(seen)).not.toContain('"s"')
  })

  it('błąd uploadu → melduje FAILED (cisza jest najgorszym trybem awarii)', async () => {
    let patched: any = null
    const { impl } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG),
      '/api/backup/runs/r1': (_u, init) => {
        patched = JSON.parse(String(init?.body))
        return jsonRes({ status: 'FAILED', changed: true })
      },
      '/api/backup/runs': () =>
        jsonRes({ runId: 'r1', uploadUrl: 'https://storage.test/put', storagePath: 'p', expiresInSeconds: 900, maxSizeMb: 500 }, 201),
      'storage.test/put': () => jsonRes({ error: 'nope' }, 500),
    })

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()

    expect(patched?.status).toBe('FAILED')
    expect(patched.error).toContain('500')
  })

  it('409 (równoległy przebieg) → grzecznie odpuszcza, bez uploadu', async () => {
    const { impl, calls } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG),
      '/api/backup/runs': () => jsonRes({ error: 'trwa' }, 409),
    })

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()

    expect(calls.some((c) => c.url.includes('storage'))).toBe(false)
  })

  it('403 (backupy wyłączone po stronie serwera) → brak uploadu', async () => {
    const { impl, calls } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG),
      '/api/backup/runs': () => jsonRes({ error: 'wyłączone' }, 403),
    })
    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()
    expect(calls.some((c) => c.url.includes('storage'))).toBe(false)
  })

  it('polityka enabled:false → nie startuje przebiegu wcale', async () => {
    const { impl, calls } = makeFetch({
      '/api/backup/config': () => jsonRes({ ...CONFIG, enabled: false }),
    })
    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()
    expect(calls.filter((c) => c.url.includes('/runs'))).toHaveLength(0)
  })
})

describe('createBackup — fail-open (bramka jakości)', () => {
  const scenarios: Array<[string, () => typeof fetch]> = [
    [
      'Lunor zwraca 500',
      () => makeFetch({ '/api/backup/config': () => jsonRes({}, 500) }).impl,
    ],
    [
      'Lunor nieosiągalny (timeout/DNS)',
      () =>
        (vi.fn(async () => {
          throw new Error('ENOTFOUND lunor.test')
        }) as unknown) as typeof fetch,
    ],
    [
      'storage odrzuca upload',
      () =>
        makeFetch({
          '/api/backup/config': () => jsonRes(CONFIG),
          '/api/backup/runs/r1': () => jsonRes({}),
          '/api/backup/runs': () =>
            jsonRes({ runId: 'r1', uploadUrl: 'https://storage.test/put', storagePath: 'p', expiresInSeconds: 9, maxSizeMb: 500 }, 201),
          'storage.test/put': () => {
            throw new Error('ECONNRESET')
          },
        }).impl,
    ],
    [
      'meldunek też nie dochodzi',
      () =>
        makeFetch({
          '/api/backup/config': () => jsonRes(CONFIG),
          '/api/backup/runs/r1': () => {
            throw new Error('padło')
          },
          '/api/backup/runs': () =>
            jsonRes({ runId: 'r1', uploadUrl: 'https://storage.test/put', storagePath: 'p', expiresInSeconds: 9, maxSizeMb: 500 }, 201),
          'storage.test/put': () => {
            throw new Error('ECONNRESET')
          },
        }).impl,
    ],
  ]

  it.each(scenarios)('nie rzuca do hosta: %s', async (_name, mk) => {
    const agent = createBackup({ ...baseOpts, fetchImpl: mk(), engine: fakeEngine() })
    await expect(agent.tick()).resolves.toBeUndefined()
  })

  it('pg_dump padł → nie rzuca, melduje porażkę', async () => {
    let patched: any = null
    const { impl } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG),
      '/api/backup/runs/r1': (_u, init) => {
        patched = JSON.parse(String(init?.body))
        return jsonRes({})
      },
      '/api/backup/runs': () =>
        jsonRes({ runId: 'r1', uploadUrl: 'https://storage.test/put', storagePath: 'p', expiresInSeconds: 9, maxSizeMb: 500 }, 201),
      'storage.test/put': () => jsonRes({}, 200),
    })

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine('x', { fail: true }) })
    await expect(agent.tick()).resolves.toBeUndefined()
    expect(patched?.status).toBe('FAILED')
  })

  it('artefakt większy niż maxSizeMb → FAILED, nie obcięta kopia', async () => {
    let patched: any = null
    // 2 MB PRAWDZIWIE nieściśliwych danych przy limicie 1 MB.
    // Uwaga: wzorce typu `(i * k) % 256` mają krótki okres i gzip miażdży je
    // do kilku KB — do testu limitu trzeba losowości, nie arytmetyki.
    const noise = randomBytes(2 * 1024 * 1024)

    const { impl } = makeFetch({
      '/api/backup/config': () => jsonRes(CONFIG),
      '/api/backup/runs/r1': (_u, init) => {
        patched = JSON.parse(String(init?.body))
        return jsonRes({})
      },
      '/api/backup/runs': () =>
        jsonRes({ runId: 'r1', uploadUrl: 'https://storage.test/put', storagePath: 'p', expiresInSeconds: 9, maxSizeMb: 1 }, 201),
      'storage.test/put': () => jsonRes({}, 200),
    })

    const engine: DumpEngine = {
      label: 'noise',
      start: () => ({ stream: Readable.from([noise]), done: Promise.resolve(), abort: () => {} }),
    }
    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine })

    await expect(agent.tick()).resolves.toBeUndefined()
    expect(patched?.status).toBe('FAILED')
  })

  it('stop() jest bezpieczny nawet bez start()', () => {
    const agent = createBackup({ ...baseOpts, engine: fakeEngine() })
    expect(() => agent.stop()).not.toThrow()
  })

  it('podwójny start() nie tworzy dwóch pętli', async () => {
    const { impl } = makeFetch({ '/api/backup/config': () => jsonRes({ ...CONFIG, enabled: false }) })
    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine(), checkIntervalMs: 60_000 })
    agent.start()
    agent.start()
    agent.stop()
    expect(agent.enabled).toBe(true)
  })
})

describe('createBackup — ETag', () => {
  it('304 nie wywraca cyklu (konfiguracja z cache)', async () => {
    let n = 0
    const impl = vi.fn(async () => {
      n++
      return n === 1 ? jsonRes({ ...CONFIG, enabled: false }, 200, '"e1"') : jsonRes({}, 304, '"e1"')
    }) as unknown as typeof fetch

    const agent = createBackup({ ...baseOpts, fetchImpl: impl, engine: fakeEngine() })
    await agent.tick()
    await expect(agent.tick()).resolves.toBeUndefined()
    expect(n).toBe(2)
  })
})
