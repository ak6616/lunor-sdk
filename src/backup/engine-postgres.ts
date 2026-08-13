// Silnik zrzutu: `pg_dump` jako strumień.
//
// 🔴 Connection string idzie przez ZMIENNĄ ŚRODOWISKOWĄ, nigdy przez argv —
// argumenty procesu widać w `ps` dla każdego użytkownika maszyny.

import { spawn } from 'node:child_process'
import type { DumpEngine, DumpHandle } from './types'

/** Ucina i maskuje wyjście błędu — `pg_dump` potrafi zwrócić fragmenty danych. */
export function sanitizeStderr(raw: string, max = 1000): string {
  return raw
    .replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, 'postgresql://***')
    .replace(/(password|PGPASSWORD)\s*=\s*\S+/gi, '$1=***')
    .trim()
    .slice(0, max)
}

export interface PostgresEngineOptions {
  databaseUrl: string
  /** Ścieżka do binarki; domyślnie z PATH. */
  binary?: string
  /** Dodatkowe argumenty. Domyślne pomijają właściciela i uprawnienia. */
  args?: string[]
}

/**
 * Rozkłada connection string na zmienne środowiskowe libpq.
 *
 * ⚠️ `pg_dump` **nie czyta** `PGURI` ani `DATABASE_URL` — pierwsza wersja tego
 * pliku tak zakładała i cicho łączyła się z domyślnym gniazdem lokalnym
 * (wykryte testem end-to-end na realnym `pg_dump`; mock ze `spawn` tego nie
 * łapie, bo sprawdza kształt wywołania, nie nazwy zmiennych).
 *
 * Realne zmienne libpq to `PGHOST`/`PGPORT`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`.
 * **Hasło idzie wyłącznie przez env** — argumenty procesu widać w `ps`.
 */
export function connectionEnv(databaseUrl: string): Record<string, string> {
  let u: URL
  try {
    u = new URL(databaseUrl)
  } catch {
    throw new Error('databaseUrl nie jest prawidłowym connection stringiem')
  }

  const env: Record<string, string> = {}
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname)
  if (u.port) env.PGPORT = u.port
  if (u.username) env.PGUSER = decodeURIComponent(u.username)
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password)

  const db = u.pathname.replace(/^\//, '')
  if (db) env.PGDATABASE = decodeURIComponent(db)

  // Supabase i inni dostawcy wymagają TLS — bez tego połączenie odbija.
  const sslmode = u.searchParams.get('sslmode')
  if (sslmode) env.PGSSLMODE = sslmode

  return env
}

export class PostgresDumpEngine implements DumpEngine {
  readonly label = 'pg_dump/gzip/aes-256-gcm'

  constructor(private opts: PostgresEngineOptions) {}

  start(): DumpHandle {
    const bin = this.opts.binary ?? 'pg_dump'
    // --no-owner/--no-acl: zrzut ma się odtwarzać na innym serwerze i innym
    // użytkowniku, a nie odtwarzać uprawnienia, których tam nie ma.
    const args = this.opts.args ?? ['--no-owner', '--no-acl']

    const child = spawn(bin, args, {
      env: { ...process.env, ...connectionEnv(this.opts.databaseUrl) },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stderr = ''
    child.stderr.on('data', (c) => {
      // Trzymamy tylko ogon — pełne wyjście błędu potrafi być ogromne.
      stderr = (stderr + String(c)).slice(-4000)
    })

    const done = new Promise<void>((resolve, reject) => {
      child.on('error', (err) => {
        reject(
          new Error(
            `Nie udało się uruchomić ${bin}: ${err.message}. ` +
              `Sprawdź, czy pg_dump jest zainstalowany i w PATH.`,
          ),
        )
      })
      child.on('close', (code) => {
        if (code === 0) resolve()
        else reject(new Error(`${bin} zakończył się kodem ${code}: ${sanitizeStderr(stderr)}`))
      })
    })

    return {
      stream: child.stdout,
      done,
      abort: () => {
        try {
          child.kill('SIGTERM')
        } catch {
          /* proces mógł już zniknąć */
        }
      },
    }
  }
}

/**
 * Connection string rozkładany na zmienne libpq (patrz `connectionEnv`).
 * Hasło trafia wyłącznie do `PGPASSWORD`, nigdy do argv.
 */
export function createPostgresEngine(databaseUrl: string): DumpEngine {
  return new PostgresDumpEngine({ databaseUrl })
}
