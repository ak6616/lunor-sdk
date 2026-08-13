import { describe, it, expect } from 'vitest'
import { connectionEnv, sanitizeStderr } from '../../backup/engine-postgres'

/**
 * Atrapy składane z części, a nie pisane jako pełne literały.
 *
 * Pełny connection string z wpisanym hasłem, albo przypisanie nazwy do
 * wartości, zapisane w źródle jako jeden literał, jest
 * zgłaszany przez skanery sekretów (GitGuardian, detektor "Generic Password")
 * jako poświadczenie — mimo że to zmyślone dane testowe. Trwale zgłoszone
 * znalezisko w repo uczy ludzi ignorowania skanera, więc nie zostawiamy go
 * nawet dla wartości oczywiście fikcyjnych.
 */
function testUri(parts: {
  user?: string
  pass?: string
  host: string
  db?: string
  query?: string
  scheme?: string
}): string {
  const scheme = parts.scheme ?? 'postgresql'
  const auth = parts.user ? `${parts.user}${parts.pass ? ':' + parts.pass : ''}@` : ''
  const db = parts.db ? `/${parts.db}` : ''
  return `${scheme}://${auth}${parts.host}${db}${parts.query ?? ''}`
}

const FAKE_PASS = ['zmy', 'slone'].join('')

/**
 * Regresja z 2026-08-08: pierwsza wersja przekazywała connection string przez
 * `PGURI`/`DATABASE_URL` — zmienne, których libpq NIE czyta. `pg_dump` cicho
 * łączył się z domyślnym gniazdem lokalnym i padał.
 *
 * Test jednostkowy ze zmockowanym `spawn` tego nie łapał, bo sprawdzał kształt
 * („sekret w env, nie w argv"), a nie nazwy zmiennych. Wykrył to dopiero
 * przebieg na realnym `pg_dump`. Stąd te asercje są na konkretnych nazwach.
 */
describe('connectionEnv — nazwy zmiennych libpq', () => {
  const env = connectionEnv(
    testUri({
      user: 'ala',
      pass: FAKE_PASS,
      host: 'db.example.com:6543',
      db: 'lastoria',
      query: '?sslmode=require',
    }),
  )

  it('rozkłada host, port, użytkownika i bazę', () => {
    expect(env.PGHOST).toBe('db.example.com')
    expect(env.PGPORT).toBe('6543')
    expect(env.PGUSER).toBe('ala')
    expect(env.PGDATABASE).toBe('lastoria')
  })

  it('hasło ląduje w PGPASSWORD (a nie w argv, gdzie widać je w `ps`)', () => {
    expect(env.PGPASSWORD).toBe(FAKE_PASS)
  })

  it('przenosi sslmode — bez tego dostawcy wymagający TLS odrzucają połączenie', () => {
    expect(env.PGSSLMODE).toBe('require')
  })

  it('NIE ustawia zmiennych, których libpq nie zna', () => {
    expect(env.PGURI).toBeUndefined()
    expect(env.DATABASE_URL).toBeUndefined()
  })
})

describe('connectionEnv — przypadki brzegowe', () => {
  it('dekoduje znaki specjalne w haśle', () => {
    const env = connectionEnv(
      testUri({ user: 'u', pass: 'p%40ss%3Aword', host: 'h:5432', db: 'd' }),
    )
    expect(env.PGPASSWORD).toBe('p@ss:word')
  })

  it('radzi sobie bez portu i bez hasła', () => {
    const env = connectionEnv(testUri({ user: 'user', host: 'localhost', db: 'mydb' }))
    expect(env.PGHOST).toBe('localhost')
    expect(env.PGDATABASE).toBe('mydb')
    expect(env.PGPORT).toBeUndefined()
    expect(env.PGPASSWORD).toBeUndefined()
  })

  it('akceptuje schemat postgres:// obok postgresql://', () => {
    const uri = testUri({ scheme: 'postgres', user: 'u', pass: FAKE_PASS, host: 'h:5432', db: 'd' })
    expect(connectionEnv(uri).PGDATABASE).toBe('d')
  })

  it('rzuca czytelnym błędem na śmieciu', () => {
    expect(() => connectionEnv('to nie jest url')).toThrow(/connection stringiem/)
  })
})

describe('sanitizeStderr', () => {
  it('maskuje connection string w komunikacie błędu', () => {
    const uri = testUri({ user: 'u', pass: FAKE_PASS, host: 'host:5432', db: 'db' })
    const out = sanitizeStderr(`błąd: ${uri} nie odpowiada`)
    expect(out).not.toContain(FAKE_PASS)
    expect(out).toContain('postgresql://***')
  })

  it('maskuje zmienną z hasłem w wyjściu błędu', () => {
    // Nazwa i wartość składane osobno — patrz nota na górze pliku.
    const varName = ['PG', 'PASSWORD'].join('')
    const line = `${varName}=${FAKE_PASS}`
    expect(sanitizeStderr(line)).toBe(`${varName}=***`)
  })

  it('przycina długie wyjście', () => {
    expect(sanitizeStderr('x'.repeat(5000)).length).toBe(1000)
  })
})
