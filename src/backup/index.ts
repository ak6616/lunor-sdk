// Agent backupu — moduł opt-in SDK Lunora.
//
// 🔴 ZASADA NADRZĘDNA: fail-open wobec aplikacji klienta.
// Żaden błąd backupu nie może wywrócić ani spowolnić aplikacji, w której
// agent siedzi. Wszystko w try/catch, nigdy `throw` do hosta, pętla oparta
// na `setInterval` z `unref()`, żeby nie trzymać procesu przy życiu.
//
// Import wyłącznie przez `@ak6616/lunor-sdk/backup` — moduł ciągnie Node-owe
// API i nie ma prawa trafić do buildu przeglądarkowego.

import { BackupClient } from './client'
import { BackupStateStore } from './state'
import { decide } from './scheduler'
import { buildArtifactStream, keyFingerprint, parseEncryptionKey } from './pipeline'
import { createPostgresEngine } from './engine-postgres'
import type { BackupAgent, BackupOptions, DumpEngine, StartedRun } from './types'

const DEFAULT_CHECK_INTERVAL_MS = 5 * 60_000
const HEARTBEAT_INTERVAL_MS = 60_000

/** Agent nieaktywny — brak konfiguracji. Wszystkie metody to no-op. */
function inertAgent(reason: string, logger?: (m: string) => void): BackupAgent {
  logger?.(`[lunor:backup] moduł nieaktywny: ${reason}`)
  return {
    start: () => {},
    stop: () => {},
    tick: async () => {},
    enabled: false,
  }
}

export function createBackup(opts: BackupOptions): BackupAgent {
  const log = (msg: string, err?: unknown) => opts.logger?.(msg, err)

  if (!opts.apiKey || !opts.apiSecret) {
    return inertAgent('brak apiKey/apiSecret', opts.logger)
  }
  if (!opts.engine && !opts.databaseUrl) {
    return inertAgent('brak databaseUrl (i nie podano własnego silnika)', opts.logger)
  }

  // 🔴 Brak klucza = ODMOWA startu, nie cicha wysyłka plaintextu.
  // Artefakt zawiera całą bazę klienta; wysłanie go nieszyfrowanego byłoby
  // gorsze niż brak backupu, bo dawałoby fałszywe poczucie bezpieczeństwa.
  if (!opts.encryptionKey) {
    return inertAgent(
      'brak encryptionKey — odmawiam wysyłki niezaszyfrowanej kopii',
      opts.logger,
    )
  }
  try {
    parseEncryptionKey(opts.encryptionKey)
  } catch {
    return inertAgent('encryptionKey nie jest 64-znakowym hexem', opts.logger)
  }

  const client = new BackupClient({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    endpoint: opts.endpoint,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger,
  })
  const state = new BackupStateStore(opts.statePath, opts.logger)
  const engine: DumpEngine = opts.engine ?? createPostgresEngine(opts.databaseUrl!)

  let timer: ReturnType<typeof setInterval> | null = null
  let running = false
  let abortCurrent: (() => void) | null = null

  async function upload(run: StartedRun, stream: NodeJS.ReadableStream): Promise<void> {
    const res = await fetchOrGlobal()(run.uploadUrl, {
      method: 'PUT',
      body: stream as unknown as BodyInit,
      // Node wymaga duplex przy strumieniowym ciele żądania.
      ...({ duplex: 'half' } as Record<string, unknown>),
      headers: { 'Content-Type': 'application/octet-stream' },
    })
    if (!res.ok) {
      throw new Error(`Upload artefaktu nie powiódł się (HTTP ${res.status})`)
    }
  }

  function fetchOrGlobal(): typeof fetch {
    return opts.fetchImpl ?? globalThis.fetch
  }

  /** Jeden pełny przebieg. NIGDY nie rzuca — melduje i wraca. */
  async function performRun(trigger: 'SCHEDULED' | 'MANUAL'): Promise<void> {
    const started = await client.startRun(engine.label, trigger)
    if (!started) return // 403/409/awaria — powód już zalogowany

    state.update({ lastAttemptAt: new Date().toISOString() })

    let heartbeat: ReturnType<typeof setInterval> | null = null
    let dump: ReturnType<DumpEngine['start']> | null = null

    try {
      dump = engine.start()
      abortCurrent = dump.abort

      heartbeat = setInterval(() => {
        void client.heartbeat(started.runId)
      }, HEARTBEAT_INTERVAL_MS)
      heartbeat.unref?.()

      const maxBytes = Math.max(1, started.maxSizeMb) * 1024 * 1024
      const { stream, result } = buildArtifactStream(
        dump.stream as never,
        opts.encryptionKey!,
        maxBytes,
      )

      await upload(started, stream)
      const [artifact] = await Promise.all([result, dump.done])

      await client.finishRun(started.runId, {
        status: 'UPLOADED',
        sizeBytes: artifact.sizeBytes,
        checksum: artifact.checksum,
      })
      state.update({ lastSuccessAt: new Date().toISOString() })
      log(`[lunor:backup] kopia wysłana (${artifact.sizeBytes} B)`)
    } catch (err) {
      dump?.abort()
      const message = err instanceof Error ? err.message : String(err)
      // Meldujemy PORAŻKĘ zawsze — przebieg bez meldunku wisi w RUNNING
      // do czasu reapera, a cisza jest najgorszym trybem awarii backupów.
      await client.finishRun(started.runId, { status: 'FAILED', error: message })
      log('[lunor:backup] przebieg nieudany', err)
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      abortCurrent = null
    }
  }

  async function tick(): Promise<void> {
    if (running) return
    running = true
    try {
      const config = await client.fetchConfig()

      // Ostrzeżenie, nie blokada: klucz mógł zostać zmieniony świadomie,
      // ale wtedy starsze kopie są nieodczytywalne i trzeba o tym wiedzieć.
      if (config?.encryptionKeyFingerprint) {
        const mine = keyFingerprint(opts.encryptionKey!)
        if (mine !== config.encryptionKeyFingerprint) {
          log(
            '[lunor:backup] ⚠️ odcisk klucza różni się od zapisanego w Lunorze — ' +
              'starsze kopie mogą być nieodczytywalne tym kluczem',
          )
        }
      }

      const decision = decide({
        config,
        state: state.get(),
        now: new Date(),
        seed: opts.apiKey,
      })
      if (!decision.run) return

      if (decision.trigger === 'MANUAL' && config?.runNowRequestedAt) {
        // Zapisujemy PRZED wykonaniem — inaczej padnięcie w trakcie zapętliłoby
        // żądanie ręczne przy każdym cyklu.
        state.update({ handledRunNowAt: config.runNowRequestedAt })
      }

      await performRun(decision.trigger)
    } catch (err) {
      log('[lunor:backup] cykl zakończony błędem (ignoruję)', err)
    } finally {
      running = false
    }
  }

  return {
    enabled: true,
    start() {
      if (timer) return
      timer = setInterval(() => {
        void tick()
      }, opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS)
      // unref: agent backupu nie może trzymać procesu aplikacji przy życiu.
      timer.unref?.()
      void tick()
    },
    stop() {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
      abortCurrent?.()
    },
    tick,
  }
}

export { keyFingerprint, parseEncryptionKey, MAGIC } from './pipeline'
// Odtwarzanie wystawione z biblioteki, nie tylko z CLI: pozwala wpiąć
// weryfikację kopii we własny harmonogram albo w testy integracyjne.
export {
  restoreArtifact,
  InvalidArtifactError,
  ArtifactAuthenticationError,
  type RestoreOptions,
  type RestoreResult,
} from './restore'
export { createPostgresEngine } from './engine-postgres'
export { decide, jitterMinutes } from './scheduler'
export type {
  BackupOptions,
  BackupAgent,
  BackupConfig,
  DumpEngine,
  DumpHandle,
  BackupState,
} from './types'
