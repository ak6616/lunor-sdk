// Rozmowa agenta backupu z Lunorem.
//
// Uwierzytelnienie identyczne jak w blockliście firewalla: X-API-Key + HMAC v1
// (podpisywany jest `${timestamp}.${rawBody}`, dla GET rawBody = pusty string).
// Reużywamy `signRequest` z `../hmac` — żadnej nowej kryptografii.

import { signRequest } from '../hmac'
import { LUNOR_ENDPOINT } from '../constants'
import type { BackupConfig, StartedRun } from './types'

const DEFAULT_TIMEOUT_MS = 15_000

export interface BackupClientOptions {
  apiKey: string
  apiSecret: string
  endpoint?: string
  timeoutMs?: number
  fetchImpl?: typeof fetch
  logger?: (msg: string, err?: unknown) => void
}

/** Wyprowadza bazę URL API z endpointu webhooka (ten sam wzorzec co firewall). */
export function deriveBackupBase(endpoint: string): string {
  if (endpoint.endsWith('/api/webhook')) {
    return endpoint.slice(0, -'/api/webhook'.length) + '/api/backup'
  }
  try {
    return `${new URL(endpoint).origin}/api/backup`
  } catch {
    return endpoint
  }
}

export class BackupClient {
  private base: string
  private fetchImpl: typeof fetch
  private etag: string | null = null
  private cachedConfig: BackupConfig | null = null

  constructor(private opts: BackupClientOptions) {
    this.base = deriveBackupBase(opts.endpoint ?? LUNOR_ENDPOINT)
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch
  }

  private log(msg: string, err?: unknown): void {
    this.opts.logger?.(`[lunor:backup] ${msg}`, err)
  }

  private async request(
    path: string,
    method: 'GET' | 'POST' | 'PATCH',
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<Response> {
    const rawBody = body === undefined ? '' : JSON.stringify(body)
    const signed = await signRequest(this.opts.apiSecret, rawBody)

    const headers: Record<string, string> = {
      'X-API-Key': this.opts.apiKey,
      ...signed,
      ...extraHeaders,
    }
    if (body !== undefined) headers['Content-Type'] = 'application/json'

    const controller = new AbortController()
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        ...(body === undefined ? {} : { body: rawBody }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Pobiera politykę. Obsługuje 304 — wtedy zwraca ostatnią znaną.
   * Przy błędzie sieci zwraca ostatnią znaną (albo null) i NIE rzuca:
   * niedostępny Lunor nie może wywrócić aplikacji klienta.
   */
  async fetchConfig(): Promise<BackupConfig | null> {
    try {
      const res = await this.request(
        '/config',
        'GET',
        undefined,
        this.etag ? { 'If-None-Match': this.etag } : undefined,
      )

      if (res.status === 304) return this.cachedConfig

      if (!res.ok) {
        // 401 najczęściej znaczy złe poświadczenia albo dryf zegara — logujemy
        // raz i zwracamy cache; ponawianie w pętli nic nie da.
        this.log(`konfiguracja niedostępna (HTTP ${res.status})`)
        return this.cachedConfig
      }

      const etag = res.headers.get('ETag')
      if (etag) this.etag = etag
      this.cachedConfig = (await res.json()) as BackupConfig
      return this.cachedConfig
    } catch (err) {
      this.log('nie udało się pobrać konfiguracji (używam ostatniej znanej)', err)
      return this.cachedConfig
    }
  }

  /** Zgłasza start przebiegu. `null`, gdy Lunor odmówił (403/409) lub padł. */
  async startRun(engineLabel: string, trigger: 'SCHEDULED' | 'MANUAL'): Promise<StartedRun | null> {
    try {
      const res = await this.request('/runs', 'POST', { trigger, engine: engineLabel })
      if (res.status === 409) {
        this.log('inny backup tego projektu już trwa — odpuszczam ten cykl')
        return null
      }
      if (!res.ok) {
        this.log(`start przebiegu odrzucony (HTTP ${res.status})`)
        return null
      }
      return (await res.json()) as StartedRun
    } catch (err) {
      this.log('nie udało się zgłosić startu przebiegu', err)
      return null
    }
  }

  /** Odświeża heartbeat długiego zrzutu. Błędy są nieistotne — nie rzucamy. */
  async heartbeat(runId: string): Promise<void> {
    try {
      await this.request(`/runs/${encodeURIComponent(runId)}/heartbeat`, 'POST', {})
    } catch (err) {
      this.log('heartbeat nie doszedł (ignoruję)', err)
    }
  }

  /**
   * Melduje wynik. Ponawiany, bo **cisza jest najgorszym trybem awarii** —
   * przebieg bez meldunku zawiśnie w RUNNING aż do reapera.
   */
  async finishRun(
    runId: string,
    result:
      | { status: 'UPLOADED'; sizeBytes: number; checksum: string }
      | { status: 'FAILED'; error: string },
    attempts = 3,
  ): Promise<boolean> {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.request(`/runs/${encodeURIComponent(runId)}`, 'PATCH', result)
        if (res.ok) return true
        // 4xx nie naprawi się przez ponowienie.
        if (res.status >= 400 && res.status < 500) {
          this.log(`meldunek odrzucony (HTTP ${res.status})`)
          return false
        }
      } catch (err) {
        this.log(`meldunek nie doszedł (próba ${i + 1}/${attempts})`, err)
      }
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1000 * 2 ** i))
      }
    }
    return false
  }
}
