// Typy modułu backupu.
//
// Moduł żyje w OSOBNYM wejściu bundla (`@ak6616/lunor-sdk/backup`), bo używa
// wyłącznie Node-owych API (`node:child_process`, `node:zlib`, `node:crypto`).
// Wciągnięcie go do głównego `index.ts` zaciągnęłoby te importy do buildów
// przeglądarkowych, które ich nie mają.

/** Polityka pobrana z Lunora (`GET /api/backup/config`). */
export interface BackupConfig {
  enabled: boolean
  intervalHours: number
  preferredHourUtc: number
  maxSizeMb: number
  /** Znacznik żądania „uruchom teraz" z panelu; agent porównuje z własnym stanem. */
  runNowRequestedAt: string | null
  /** Odcisk klucza, którym Lunor spodziewa się zaszyfrowanych kopii. */
  encryptionKeyFingerprint: string | null
}

/** Odpowiedź na `POST /api/backup/runs`. */
export interface StartedRun {
  runId: string
  uploadUrl: string
  storagePath: string
  expiresInSeconds: number
  maxSizeMb: number
}

/** Stan trzymany na dysku — musi przetrwać restart procesu (RPi wstaje w nocy). */
export interface BackupState {
  /** ISO ostatniego przebiegu zakończonego sukcesem. */
  lastSuccessAt: string | null
  /** ISO ostatniej próby (udanej lub nie) — chroni przed pętlą retry. */
  lastAttemptAt: string | null
  /** Obsłużony znacznik „uruchom teraz"; zapobiega powtórzeniu po restarcie. */
  handledRunNowAt: string | null
}

/** Silnik zrzutu — interfejs od początku, implementacja na razie jedna. */
export interface DumpEngine {
  /** Etykieta trafiająca do `BackupRun.engine`, np. `pg_dump-16/gzip/aes-256-gcm`. */
  readonly label: string
  /** Uruchamia zrzut i zwraca strumień bajtów. */
  start(): DumpHandle
}

export interface DumpHandle {
  /** Strumień z surowym zrzutem (przed kompresją i szyfrowaniem). */
  stream: NodeJS.ReadableStream
  /** Rozstrzyga się, gdy proces zakończy pracę; odrzuca przy błędzie. */
  done: Promise<void>
  /** Przerywa zrzut (limit rozmiaru, zamykanie agenta). */
  abort(): void
}

export interface BackupOptions {
  /** Klucz publiczny projektu (nagłówek `X-API-Key`). */
  apiKey: string
  /** Sekret projektu — używany WYŁĄCZNIE do podpisu HMAC, nigdy wysyłany. */
  apiSecret: string
  /** Bazowy endpoint webhooka; ścieżki backupu wyprowadzane automatycznie. */
  endpoint?: string

  /** Connection string bazy do zrzutu. Przekazywany procesowi przez env. */
  databaseUrl?: string
  /**
   * Klucz szyfrujący artefakt (hex, 32 bajty = 64 znaki).
   *
   * 🔴 Lunor go NIE ZNA i nie ma jak odtworzyć. Utrata klucza = wszystkie
   * kopie bezużyteczne. Trzymać poza tym systemem.
   */
  encryptionKey?: string

  /** Jak często sprawdzać politykę i czy nie czas na backup. Domyślnie 5 min. */
  checkIntervalMs?: number
  /** Ścieżka pliku ze stanem. Bez niej restart gubi harmonogram. */
  statePath?: string
  /** Podmiana silnika zrzutu (testy, inne bazy). */
  engine?: DumpEngine
  /** Podmiana `fetch` (testy). */
  fetchImpl?: typeof fetch
  /** Logger; domyślnie cisza — agent nie zaśmieca logów aplikacji klienta. */
  logger?: (msg: string, err?: unknown) => void
}

export interface BackupAgent {
  /** Uruchamia pętlę sprawdzającą. Bezpieczne do wołania wielokrotnie. */
  start(): void
  /** Zatrzymuje pętlę i przerywa trwający zrzut. */
  stop(): void
  /** Wymusza jeden cykl teraz (test, diagnostyka). Nigdy nie rzuca. */
  tick(): Promise<void>
  /** Czy moduł jest aktywny (ma komplet konfiguracji). */
  readonly enabled: boolean
}
