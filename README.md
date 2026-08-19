# Lunor SDK

Monitoring, logging and edge-protection client for the [Lunor](https://www.lunor.com.pl) observability platform. Runs in the browser and on Node.js (>= 20), ships as a hybrid ESM/CJS package with generated type definitions.

Three things live here, and they are deliberately separate:

| Module | Import | Runtime | What it does |
|---|---|---|---|
| **Core** | `@ak6616/lunor-sdk` | browser + Node | logs, errors, security events — batched, queued, retried |
| **Firewall** | `@ak6616/lunor-sdk` → `createFirewall` | Node | enforces a centrally-managed IP blocklist at the edge of your app |
| **Backup agent** | `@ak6616/lunor-sdk/backup` | Node only | encrypted database snapshots, opt-in, scheduled by the server |

The backup agent is behind its own import path on purpose: it pulls in `child_process`, `zlib` and `crypto`, so it must never end up in a browser bundle.

---

## Install

```bash
npm install @ak6616/lunor-sdk
```

Published to GitHub Packages. Add to `.npmrc`:

```
@ak6616:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NPM_TOKEN}
```

---

## Quickstart

```ts
import { init, LogLevel } from '@ak6616/lunor-sdk'

const lunor = init({
  apiKey: process.env.LUNOR_API_KEY!,
  apiSecret: process.env.LUNOR_API_SECRET!,
  environment: 'production',

  captureGlobalErrors: true,        // uncaughtException / window.onerror
  captureUnhandledRejections: true,
  minLogLevel: LogLevel.INFO,
  sampleRate: 1.0,
})

lunor.info('checkout completed', { orderId, amount })

try {
  await chargeCard(order)
} catch (err) {
  lunor.captureError(err)
  throw err
}
```

Events are queued, batched and flushed on an interval (or when the batch fills). Nothing blocks your request path.

### What happens when the network is down

Events do not disappear. The queue holds them, retries with exponential backoff **and jitter**, and — if `enablePersistence` is on in the browser — survives a page reload via `localStorage`. When the queue hits its size cap it evicts rather than growing without bound.

This is the part most logging integrations get wrong: an outage in your telemetry provider becomes an outage in your app. Here it cannot.

---

## Firewall

A rule engine whose blocklist lives in Lunor and is enforced inside your application.

```ts
import { init, createFirewall } from '@ak6616/lunor-sdk'

const lunor = init({ apiKey, apiSecret })

const firewall = createFirewall({
  client: lunor,
  apiKey,
  apiSecret,
  pollIntervalMs: 60_000,
  snapshotPath: '/var/lib/myapp/blocklist.json',
})

firewall.start()
app.use(firewall.express())

process.on('SIGTERM', () => firewall.stop())
```

Blocked requests are answered with `403` and reported back as a `FIREWALL_BLOCK` security event. There is also a monitor mode that reports `FIREWALL_WOULD_BLOCK` without actually blocking — so you can watch a rule against real traffic before you let it bite.

### The design decision worth explaining

The blocklist is **pulled**, on a timer, with `ETag`/`304` revalidation and HMAC-signed payloads. It is never pushed, and the control plane never gets a channel that can execute anything inside the protected app.

That is not an implementation detail — it is the whole security argument. Lunor sits behind a public domain. If it were compromised, a push channel would hand the attacker code execution inside every application that trusts it. A pull-only, signed, strictly-typed blocklist means a compromised control plane costs you a bad blocklist, not your servers.

`snapshotPath` exists so a restart does not open a window with no rules loaded. It is for long-lived processes only; serverless should leave it unset and rely on the poll.

**Status:** running in ENFORCE mode against live production traffic since July 2026 — real `403`s served, block and unblock verified end to end.

---

## Backup agent

Scheduled, encrypted Postgres snapshots shipped to external storage. **Opt-in** — without configuration it does nothing.

```ts
import { createBackup } from '@ak6616/lunor-sdk/backup'

const backup = createBackup({
  apiKey: process.env.LUNOR_API_KEY!,
  apiSecret: process.env.LUNOR_API_SECRET!,
  databaseUrl: process.env.DATABASE_URL!,
  encryptionKey: process.env.LUNOR_BACKUP_KEY!,   // 64 hex chars
  statePath: '/var/lib/myapp/lunor-backup.json',  // must survive restarts
})

backup.start()
process.on('SIGTERM', () => backup.stop())
```

Requires `pg_dump` on `PATH`, at a version no older than the server. Schedule, retention and the on/off switch live server-side — the agent only polls the policy.

### Encryption

The artifact is encrypted with **AES-256-GCM before it leaves the machine**. Lunor stores an opaque blob and never sees the key.

> ⚠️ **Losing the key means losing every backup, including ones already taken.** Nobody can recover them — not us, not the storage provider. Keep the key outside this system: a password manager, or paper in a safe. Not only an environment variable on the machine you are backing up.

Generate one with `openssl rand -hex 32`. Without `encryptionKey` the module **refuses to start** — it will never ship an unencrypted copy.

Artifact layout: `[8B "LUNORBK1"][12B IV][ciphertext][16B authTag]`. The IV and auth tag travel inside the file, so restoring needs nothing but the file and the key:

```bash
KEY=<hex> node -e '
const {createDecipheriv}=require("crypto"),{gunzipSync}=require("zlib"),fs=require("fs");
const a=fs.readFileSync(process.argv[1]), key=Buffer.from(process.env.KEY,"hex");
const d=createDecipheriv("aes-256-gcm",key,a.subarray(8,20));
d.setAuthTag(a.subarray(a.length-16));
fs.writeFileSync("dump.sql",gunzipSync(Buffer.concat([d.update(a.subarray(20,a.length-16)),d.final()])));
' artifact.dump.gz.enc

psql -d target_database -f dump.sql
```

> **A backup you have never restored is theatre.** Rehearse the above against a scratch database before you call this feature done.

### Fail-open

No backup failure may take down the application hosting the agent. Lunor unreachable, `pg_dump` crashed, upload rejected, disk full — each ends as a log line and a failure report, never as an exception thrown into the host process.

---

## Data scrubbing

Secrets and PII are redacted before anything is stored or sent, at **five** independent points: console capture, `captureError` / `captureException`, `setUser`, queue persistence, and a final defensive pass in the transport layer.

```ts
import { scrubSensitive, maskEmail } from '@ak6616/lunor-sdk'
```

Keys matching `password`, `secret`, `token`, `apiKey` and friends are redacted wherever they appear in the object graph. Traversal is bounded — max depth 5, max 100 array items, 8 KB per string — so a hostile or pathological payload cannot turn logging into a denial of service.

The redundancy is deliberate. Any one of those five layers could be bypassed by a future code path; the point is that no single mistake is enough to leak a credential into stored telemetry.

---

## Architecture

```
LunorClient ──┬── Middleware ──► Queue ──► Transport ──► Lunor API
              │                    │           │
              │                    │           └─ retry (exp. backoff + jitter,
              │                    │              bounded concurrency)
              │                    └─ eviction policy, optional localStorage
              ├── Context      (OS, runtime, memory, URL, user agent)
              ├── Scrubber     (applied at five layers, never throws)
              └── GlobalHandlers (uncaught errors, console interception)
```

Notes on a few choices:

- **`apiSecret` is never transmitted.** Since v2.1 it is used to derive request signatures, not sent as a header. The old `X-API-Secret` constant is retained as `@deprecated` only so existing integrations fail loudly rather than silently.
- **The SDK version is injected at build time** from `package.json` via tsup `define`, so a released package cannot disagree with the version it reports. This followed a real drift in 2.3.1, where the constant said `2.3.0`.
- **The scrubber never throws.** Best-effort cleaning that returns something is strictly better than an exception raised while handling another exception.

---

## Development

```bash
npm install
npm run build        # tsup → dist/ (ESM + CJS + .d.ts)
npm test             # vitest
npm run type-check   # tsc --noEmit
npm run test:coverage
```

## License

Proprietary. The source is published for reference and for use by Lunor integrations; it is not offered under an open-source licence.
