/** Polityka pobrana z Lunora (`GET /api/backup/config`). */
interface BackupConfig {
    enabled: boolean;
    intervalHours: number;
    preferredHourUtc: number;
    maxSizeMb: number;
    /** Znacznik żądania „uruchom teraz" z panelu; agent porównuje z własnym stanem. */
    runNowRequestedAt: string | null;
    /** Odcisk klucza, którym Lunor spodziewa się zaszyfrowanych kopii. */
    encryptionKeyFingerprint: string | null;
}
/** Stan trzymany na dysku — musi przetrwać restart procesu (RPi wstaje w nocy). */
interface BackupState {
    /** ISO ostatniego przebiegu zakończonego sukcesem. */
    lastSuccessAt: string | null;
    /** ISO ostatniej próby (udanej lub nie) — chroni przed pętlą retry. */
    lastAttemptAt: string | null;
    /** Obsłużony znacznik „uruchom teraz"; zapobiega powtórzeniu po restarcie. */
    handledRunNowAt: string | null;
}
/** Silnik zrzutu — interfejs od początku, implementacja na razie jedna. */
interface DumpEngine {
    /** Etykieta trafiająca do `BackupRun.engine`, np. `pg_dump-16/gzip/aes-256-gcm`. */
    readonly label: string;
    /** Uruchamia zrzut i zwraca strumień bajtów. */
    start(): DumpHandle;
}
interface DumpHandle {
    /** Strumień z surowym zrzutem (przed kompresją i szyfrowaniem). */
    stream: NodeJS.ReadableStream;
    /** Rozstrzyga się, gdy proces zakończy pracę; odrzuca przy błędzie. */
    done: Promise<void>;
    /** Przerywa zrzut (limit rozmiaru, zamykanie agenta). */
    abort(): void;
}
interface BackupOptions {
    /** Klucz publiczny projektu (nagłówek `X-API-Key`). */
    apiKey: string;
    /** Sekret projektu — używany WYŁĄCZNIE do podpisu HMAC, nigdy wysyłany. */
    apiSecret: string;
    /** Bazowy endpoint webhooka; ścieżki backupu wyprowadzane automatycznie. */
    endpoint?: string;
    /** Connection string bazy do zrzutu. Przekazywany procesowi przez env. */
    databaseUrl?: string;
    /**
     * Klucz szyfrujący artefakt (hex, 32 bajty = 64 znaki).
     *
     * 🔴 Lunor go NIE ZNA i nie ma jak odtworzyć. Utrata klucza = wszystkie
     * kopie bezużyteczne. Trzymać poza tym systemem.
     */
    encryptionKey?: string;
    /** Jak często sprawdzać politykę i czy nie czas na backup. Domyślnie 5 min. */
    checkIntervalMs?: number;
    /** Ścieżka pliku ze stanem. Bez niej restart gubi harmonogram. */
    statePath?: string;
    /** Podmiana silnika zrzutu (testy, inne bazy). */
    engine?: DumpEngine;
    /** Podmiana `fetch` (testy). */
    fetchImpl?: typeof fetch;
    /** Logger; domyślnie cisza — agent nie zaśmieca logów aplikacji klienta. */
    logger?: (msg: string, err?: unknown) => void;
}
interface BackupAgent {
    /** Uruchamia pętlę sprawdzającą. Bezpieczne do wołania wielokrotnie. */
    start(): void;
    /** Zatrzymuje pętlę i przerywa trwający zrzut. */
    stop(): void;
    /** Wymusza jeden cykl teraz (test, diagnostyka). Nigdy nie rzuca. */
    tick(): Promise<void>;
    /** Czy moduł jest aktywny (ma komplet konfiguracji). */
    readonly enabled: boolean;
}

declare const MAGIC: Buffer<ArrayBuffer>;
declare function parseEncryptionKey(hex: string): Buffer;
/**
 * Odcisk klucza do porównania z tym, czego spodziewa się Lunor.
 * Sam klucz nigdy nie opuszcza maszyny klienta — wysyłamy wyłącznie odcisk.
 */
declare function keyFingerprint(hex: string): string;

/**
 * Connection string rozkładany na zmienne libpq (patrz `connectionEnv`).
 * Hasło trafia wyłącznie do `PGPASSWORD`, nigdy do argv.
 */
declare function createPostgresEngine(databaseUrl: string): DumpEngine;

type Decision = {
    run: false;
    reason: string;
} | {
    run: true;
    trigger: 'SCHEDULED' | 'MANUAL';
    reason: string;
};
/**
 * Deterministyczny jitter 0–59 min wyprowadzony z klucza projektu.
 *
 * Bez tego wiele instancji z tą samą polityką uderza w tej samej minucie.
 * Deterministyczny, a nie losowy, żeby restart procesu nie przesuwał okna.
 */
declare function jitterMinutes(seed: string): number;
declare function decide(params: {
    config: BackupConfig | null;
    state: BackupState;
    now: Date;
    seed: string;
}): Decision;

declare function createBackup(opts: BackupOptions): BackupAgent;

export { type BackupAgent, type BackupConfig, type BackupOptions, type BackupState, type DumpEngine, type DumpHandle, MAGIC, createBackup, createPostgresEngine, decide, jitterMinutes, keyFingerprint, parseEncryptionKey };
