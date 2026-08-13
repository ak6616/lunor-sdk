#!/usr/bin/env node
// CLI odtwarzania kopii: `lunor-backup`.
//
// Istnieje, bo odtwarzanie musi być czynnością wyuczoną i przećwiczoną, a nie
// improwizacją w dniu awarii. Jeśli jedyną drogą do odzyskania bazy jest
// napisanie skryptu od zera pod presją, backup jest teatrem.
//
// 🔴 KLUCZ NIE IDZIE PRZEZ ARGV. Argumenty procesu widzi w `ps` każdy
// użytkownik maszyny, a klucz szyfrujący otwiera WSZYSTKIE kopie tego projektu
// — więc jest wrażliwszy niż hasło do bazy, które `engine-postgres.ts` już
// z argv trzyma z daleka. Przyjmujemy go wyłącznie z `LUNOR_BACKUP_KEY`
// albo z pliku (`--key-file`).

import { createReadStream, createWriteStream, readFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { restoreArtifact } from './restore'
import { connectionEnv } from './engine-postgres'

const USAGE = `
lunor-backup — odtwarzanie kopii Lunora

  lunor-backup verify  --in <artefakt>  [--checksum <sha256>]
  lunor-backup restore --in <artefakt>  --out <plik.sql>
  lunor-backup restore --in <artefakt>  --to-database

Argumenty:
  --in <plik>        artefakt (.dump.gz.enc); "-" czyta ze standardowego wejścia
  --out <plik>       dokąd zapisać odszyfrowany zrzut SQL; "-" pisze na stdout
  --to-database      wpuszcza zrzut prosto do psql (wymaga DATABASE_URL)
  --checksum <hex>   oczekiwana suma sha256 artefaktu (z panelu Lunora)
  --key-file <plik>  plik z kluczem szyfrującym (64 znaki hex)

Klucz szyfrujący:
  Z LUNOR_BACKUP_KEY albo z --key-file. NIE ma opcji --key, bo argumenty
  procesu widać w \`ps\` dla każdego użytkownika maszyny.

Baza docelowa (tylko --to-database):
  Z DATABASE_URL. UWAGA: zrzut nadpisuje istniejące obiekty — kieruj go na
  świeżą bazę, a nie na produkcję.

verify nie zapisuje niczego. Przepuszcza artefakt przez deszyfrator i gunzip,
więc dowodzi, że kopia jest odczytywalna TYM kluczem. To jest test do
uruchamiania regularnie, nie po awarii.
`.trim()

interface Args {
  command: string
  in?: string
  out?: string
  checksum?: string
  keyFile?: string
  toDatabase: boolean
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { command: argv[0] ?? '', toDatabase: false }
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]
    const next = () => {
      const v = argv[++i]
      if (v === undefined) throw new Error(`Brakuje wartości dla ${a}`)
      return v
    }
    switch (a) {
      case '--in': args.in = next(); break
      case '--out': args.out = next(); break
      case '--checksum': args.checksum = next(); break
      case '--key-file': args.keyFile = next(); break
      case '--to-database': args.toDatabase = true; break
      case '--key':
        throw new Error(
          'Opcja --key nie istnieje celowo: argumenty procesu widać w `ps`. ' +
            'Użyj zmiennej LUNOR_BACKUP_KEY albo --key-file.',
        )
      default:
        throw new Error(`Nieznany argument: ${a}`)
    }
  }
  return args
}

export function resolveKey(args: Args, env: NodeJS.ProcessEnv): string {
  if (args.keyFile) return readFileSync(args.keyFile, 'utf8').trim()
  const fromEnv = env.LUNOR_BACKUP_KEY?.trim()
  if (fromEnv) return fromEnv
  throw new Error(
    'Brak klucza szyfrującego. Ustaw LUNOR_BACKUP_KEY albo podaj --key-file.',
  )
}

function openSource(path: string): Readable {
  return path === '-' ? process.stdin : createReadStream(path)
}

/** Formatuje bajty tak, żeby dało się je przeczytać w logu wdrożeniowym. */
function human(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']
  let v = bytes
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  let args: Args
  try {
    args = parseArgs(argv)
  } catch (err) {
    console.error(`Błąd: ${(err as Error).message}\n`)
    console.error(USAGE)
    return 2
  }

  if (args.command === 'help' || args.command === '--help' || args.command === '-h' || !args.command) {
    console.log(USAGE)
    return args.command ? 0 : 2
  }
  if (args.command !== 'verify' && args.command !== 'restore') {
    console.error(`Nieznane polecenie: ${args.command}\n`)
    console.error(USAGE)
    return 2
  }
  if (!args.in) {
    console.error('Błąd: brakuje --in\n')
    console.error(USAGE)
    return 2
  }

  let key: string
  try {
    key = resolveKey(args, env)
  } catch (err) {
    console.error(`Błąd: ${(err as Error).message}`)
    return 2
  }

  // Cel zapisu ustalamy PRZED rozpoczęciem strumienia, żeby błąd konfiguracji
  // nie objawił się po godzinie deszyfrowania stugigowego artefaktu.
  let sink: NodeJS.WritableStream | undefined
  let psql: ReturnType<typeof spawn> | null = null

  if (args.command === 'restore') {
    if (args.toDatabase) {
      const url = env.DATABASE_URL
      if (!url) {
        console.error('Błąd: --to-database wymaga DATABASE_URL.')
        return 2
      }
      // Hasło idzie przez env (libpq), nie przez argv — jak w silniku zrzutu.
      psql = spawn('psql', ['--quiet', '--no-psqlrc'], {
        env: { ...process.env, ...connectionEnv(url) },
        stdio: ['pipe', 'inherit', 'inherit'],
      })
      sink = psql.stdin!
    } else if (args.out) {
      sink = args.out === '-' ? process.stdout : createWriteStream(args.out)
    } else {
      console.error('Błąd: restore wymaga --out albo --to-database\n')
      console.error(USAGE)
      return 2
    }
  }

  try {
    const result = await restoreArtifact({
      source: openSource(args.in),
      encryptionKeyHex: key,
      sink: sink as never,
      expectedChecksum: args.checksum,
    })

    if (psql) {
      const code = await new Promise<number>((resolve) => psql!.on('close', resolve))
      if (code !== 0) {
        console.error(`psql zakończył się kodem ${code} — odtwarzanie NIEUDANE.`)
        return 1
      }
    }

    const co = args.command === 'verify' ? 'Artefakt poprawny' : 'Odtworzono'
    console.error(
      `${co}: ${human(result.sizeBytes)} artefaktu → ${human(result.plaintextBytes)} zrzutu SQL`,
    )
    console.error(`sha256: ${result.checksum}`)
    if (args.checksum) console.error('Suma kontrolna zgodna z podaną.')
    return 0
  } catch (err) {
    // `| head` zamyka wyjście wcześniej — to normalne zachowanie powłoki,
    // a nie awaria odtwarzania. Bez tego `lunor-backup restore --out - | head`
    // straszy komunikatem o nieudanym odtworzeniu, co przy narzędziu
    // ratunkowym jest gorsze niż bezużyteczne.
    if ((err as NodeJS.ErrnoException)?.code === 'EPIPE') {
      psql?.kill()
      return 0
    }
    // Komunikat, nie ślad stosu: to narzędzie bywa uruchamiane przez kogoś,
    // kto właśnie stracił bazę i nie ma nastroju na czytanie stack trace'ów.
    console.error(`ODTWARZANIE NIEUDANE: ${(err as Error).message}`)
    psql?.kill()
    return 1
  }
}

/* c8 ignore start — cienka warstwa uruchomieniowa, logika jest w `main` */
if (process.argv[1] && /lunor-backup|cli\.(t|j|mj|cj)s$/.test(process.argv[1])) {
  main(process.argv.slice(2), process.env)
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(`Błąd krytyczny: ${err?.message ?? err}`)
      process.exit(1)
    })
}
/* c8 ignore stop */
