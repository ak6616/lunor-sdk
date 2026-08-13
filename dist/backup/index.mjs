// src/hmac.ts
var HEADER_SIGNATURE = "X-Lunor-Signature";
var HEADER_TIMESTAMP = "X-Lunor-Timestamp";
function nowUnixSeconds() {
  return Math.floor(Date.now() / 1e3).toString();
}
function hexFromBuffer(buf) {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    const h = bytes[i].toString(16);
    out += h.length === 1 ? "0" + h : h;
  }
  return out;
}
async function hmacSha256Hex(secret, message) {
  const subtle = typeof globalThis !== "undefined" ? globalThis.crypto?.subtle : void 0;
  if (subtle) {
    const enc = new TextEncoder();
    const key = await subtle.importKey(
      "raw",
      enc.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"]
    );
    const sig = await subtle.sign("HMAC", key, enc.encode(message));
    return hexFromBuffer(sig);
  }
  try {
    const nodeCrypto = await import("crypto");
    return nodeCrypto.createHmac("sha256", secret).update(message).digest("hex");
  } catch (err) {
    throw new Error(
      "[Lunor] No crypto implementation available for HMAC signing: " + (err instanceof Error ? err.message : String(err))
    );
  }
}
async function signRequest(apiSecret, rawBody, timestamp = nowUnixSeconds()) {
  const signature = await hmacSha256Hex(apiSecret, `${timestamp}.${rawBody}`);
  return {
    [HEADER_SIGNATURE]: `v1=${signature}`,
    [HEADER_TIMESTAMP]: timestamp
  };
}

// src/constants.ts
var LUNOR_ENDPOINT = "https://www.lunor.com.pl/api/webhook";
var DEFAULT_CONFIG = {
  // Endpoint jest stały — zawsze Twój serwer
  endpoint: LUNOR_ENDPOINT,
  batchSize: 10,
  flushInterval: 5e3,
  maxRetries: 3,
  retryBaseDelay: 1e3,
  retryMaxDelay: 3e4,
  timeout: 1e4,
  captureGlobalErrors: true,
  captureUnhandledRejections: true,
  captureConsole: false,
  captureConsoleLevels: ["error", "warn"],
  enablePersistence: true,
  persistencePrefix: "__lunor_",
  maxQueueSize: 1e3,
  minLogLevel: "DEBUG" /* DEBUG */,
  debug: false,
  defaultSource: "app",
  environment: "production",
  sampleRate: 1,
  enablePerformance: false
};
var LOG_LEVEL_PRIORITY = {
  ["DEBUG" /* DEBUG */]: 0,
  ["INFO" /* INFO */]: 1,
  ["WARN" /* WARN */]: 2,
  ["ERROR" /* ERROR */]: 3,
  ["FATAL" /* FATAL */]: 4
};

// src/backup/client.ts
var DEFAULT_TIMEOUT_MS = 15e3;
function deriveBackupBase(endpoint) {
  if (endpoint.endsWith("/api/webhook")) {
    return endpoint.slice(0, -"/api/webhook".length) + "/api/backup";
  }
  try {
    return `${new URL(endpoint).origin}/api/backup`;
  } catch {
    return endpoint;
  }
}
var BackupClient = class {
  constructor(opts) {
    this.opts = opts;
    this.etag = null;
    this.cachedConfig = null;
    this.base = deriveBackupBase(opts.endpoint ?? LUNOR_ENDPOINT);
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
  }
  log(msg, err) {
    this.opts.logger?.(`[lunor:backup] ${msg}`, err);
  }
  async request(path, method, body, extraHeaders) {
    const rawBody = body === void 0 ? "" : JSON.stringify(body);
    const signed = await signRequest(this.opts.apiSecret, rawBody);
    const headers = {
      "X-API-Key": this.opts.apiKey,
      ...signed,
      ...extraHeaders
    };
    if (body !== void 0) headers["Content-Type"] = "application/json";
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    try {
      return await this.fetchImpl(`${this.base}${path}`, {
        method,
        headers,
        ...body === void 0 ? {} : { body: rawBody },
        signal: controller.signal
      });
    } finally {
      clearTimeout(timer);
    }
  }
  /**
   * Pobiera politykę. Obsługuje 304 — wtedy zwraca ostatnią znaną.
   * Przy błędzie sieci zwraca ostatnią znaną (albo null) i NIE rzuca:
   * niedostępny Lunor nie może wywrócić aplikacji klienta.
   */
  async fetchConfig() {
    try {
      const res = await this.request(
        "/config",
        "GET",
        void 0,
        this.etag ? { "If-None-Match": this.etag } : void 0
      );
      if (res.status === 304) return this.cachedConfig;
      if (!res.ok) {
        this.log(`konfiguracja niedost\u0119pna (HTTP ${res.status})`);
        return this.cachedConfig;
      }
      const etag = res.headers.get("ETag");
      if (etag) this.etag = etag;
      this.cachedConfig = await res.json();
      return this.cachedConfig;
    } catch (err) {
      this.log("nie uda\u0142o si\u0119 pobra\u0107 konfiguracji (u\u017Cywam ostatniej znanej)", err);
      return this.cachedConfig;
    }
  }
  /** Zgłasza start przebiegu. `null`, gdy Lunor odmówił (403/409) lub padł. */
  async startRun(engineLabel, trigger) {
    try {
      const res = await this.request("/runs", "POST", { trigger, engine: engineLabel });
      if (res.status === 409) {
        this.log("inny backup tego projektu ju\u017C trwa \u2014 odpuszczam ten cykl");
        return null;
      }
      if (!res.ok) {
        this.log(`start przebiegu odrzucony (HTTP ${res.status})`);
        return null;
      }
      return await res.json();
    } catch (err) {
      this.log("nie uda\u0142o si\u0119 zg\u0142osi\u0107 startu przebiegu", err);
      return null;
    }
  }
  /** Odświeża heartbeat długiego zrzutu. Błędy są nieistotne — nie rzucamy. */
  async heartbeat(runId) {
    try {
      await this.request(`/runs/${encodeURIComponent(runId)}/heartbeat`, "POST", {});
    } catch (err) {
      this.log("heartbeat nie doszed\u0142 (ignoruj\u0119)", err);
    }
  }
  /**
   * Melduje wynik. Ponawiany, bo **cisza jest najgorszym trybem awarii** —
   * przebieg bez meldunku zawiśnie w RUNNING aż do reapera.
   */
  async finishRun(runId, result, attempts = 3) {
    for (let i = 0; i < attempts; i++) {
      try {
        const res = await this.request(`/runs/${encodeURIComponent(runId)}`, "PATCH", result);
        if (res.ok) return true;
        if (res.status >= 400 && res.status < 500) {
          this.log(`meldunek odrzucony (HTTP ${res.status})`);
          return false;
        }
      } catch (err) {
        this.log(`meldunek nie doszed\u0142 (pr\xF3ba ${i + 1}/${attempts})`, err);
      }
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, 1e3 * 2 ** i));
      }
    }
    return false;
  }
};

// src/backup/state.ts
import fs from "fs";
var EMPTY_STATE = {
  lastSuccessAt: null,
  lastAttemptAt: null,
  handledRunNowAt: null
};
var BackupStateStore = class {
  constructor(path, logger) {
    this.path = path;
    this.logger = logger;
    this.state = { ...EMPTY_STATE };
    this.load();
  }
  get() {
    return { ...this.state };
  }
  /** Scala i zapisuje. Błąd zapisu nie jest fatalny — gorszy stan, nie awaria. */
  update(patch) {
    this.state = { ...this.state, ...patch };
    this.save();
  }
  load() {
    if (!this.path) return;
    try {
      if (!fs.existsSync(this.path)) return;
      const parsed = JSON.parse(fs.readFileSync(this.path, "utf8"));
      this.state = {
        lastSuccessAt: typeof parsed.lastSuccessAt === "string" ? parsed.lastSuccessAt : null,
        lastAttemptAt: typeof parsed.lastAttemptAt === "string" ? parsed.lastAttemptAt : null,
        handledRunNowAt: typeof parsed.handledRunNowAt === "string" ? parsed.handledRunNowAt : null
      };
    } catch (err) {
      this.logger?.("[lunor:backup] nie uda\u0142o si\u0119 wczyta\u0107 stanu (startuj\u0119 od zera)", err);
    }
  }
  save() {
    if (!this.path) return;
    try {
      fs.writeFileSync(this.path, JSON.stringify(this.state), "utf8");
    } catch (err) {
      this.logger?.("[lunor:backup] nie uda\u0142o si\u0119 zapisa\u0107 stanu (ignoruj\u0119)", err);
    }
  }
};

// src/backup/scheduler.ts
var MIN_RETRY_MINUTES = 30;
function jitterMinutes(seed) {
  let h = 0;
  for (let i = 0; i < seed.length; i++) {
    h = h * 31 + seed.charCodeAt(i) >>> 0;
  }
  return h % 60;
}
function hoursBetween(a, b) {
  return (b.getTime() - a.getTime()) / 36e5;
}
function decide(params) {
  const { config, state, now, seed } = params;
  if (!config) return { run: false, reason: "brak konfiguracji" };
  if (!config.enabled) return { run: false, reason: "backupy wy\u0142\u0105czone" };
  if (config.runNowRequestedAt && config.runNowRequestedAt !== state.handledRunNowAt) {
    return { run: true, trigger: "MANUAL", reason: "\u017C\u0105danie z panelu" };
  }
  if (state.lastAttemptAt) {
    const sinceAttempt = hoursBetween(new Date(state.lastAttemptAt), now) * 60;
    if (sinceAttempt < MIN_RETRY_MINUTES) {
      return { run: false, reason: "zbyt niedawna pr\xF3ba" };
    }
  }
  if (!state.lastSuccessAt) {
    return { run: true, trigger: "SCHEDULED", reason: "brak jakiejkolwiek kopii" };
  }
  const elapsed = hoursBetween(new Date(state.lastSuccessAt), now);
  if (elapsed < config.intervalHours) {
    return { run: false, reason: "interwa\u0142 jeszcze nie min\u0105\u0142" };
  }
  if (config.intervalHours >= 24) {
    const jitter = jitterMinutes(seed);
    const windowStart = config.preferredHourUtc * 60 + jitter;
    const minuteOfDay = now.getUTCHours() * 60 + now.getUTCMinutes();
    const inWindow = minuteOfDay >= windowStart && minuteOfDay < windowStart + 60;
    const overdue = elapsed >= config.intervalHours * 2;
    if (!inWindow && !overdue) {
      return { run: false, reason: "poza preferowanym oknem" };
    }
  }
  return { run: true, trigger: "SCHEDULED", reason: "interwa\u0142 min\u0105\u0142" };
}

// src/backup/pipeline.ts
import { createCipheriv, createHash, randomBytes } from "crypto";
import { createGzip } from "zlib";
import { Transform } from "stream";
var MAGIC = Buffer.from("LUNORBK1", "utf8");
var IV_BYTES = 12;
var BackupSizeExceededError = class extends Error {
  constructor(limitBytes) {
    super(`Artefakt przekroczy\u0142 limit ${limitBytes} B \u2014 przerwano`);
    this.name = "BackupSizeExceededError";
  }
};
var InvalidEncryptionKeyError = class extends Error {
  constructor() {
    super("encryptionKey musi by\u0107 64-znakowym hexem (32 bajty)");
    this.name = "InvalidEncryptionKeyError";
  }
};
function parseEncryptionKey(hex) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new InvalidEncryptionKeyError();
  }
  return Buffer.from(hex, "hex");
}
function keyFingerprint(hex) {
  return createHash("sha256").update(parseEncryptionKey(hex)).digest("hex").slice(0, 16);
}
function limiter(limitBytes, onTotal) {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > limitBytes) {
        cb(new BackupSizeExceededError(limitBytes));
        return;
      }
      onTotal(total);
      cb(null, chunk);
    }
  });
}
function buildArtifactStream(source, encryptionKeyHex, maxSizeBytes) {
  const key = parseEncryptionKey(encryptionKeyHex);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const hash = createHash("sha256");
  let sizeBytes = 0;
  let settle;
  let fail;
  const result = new Promise((res, rej) => {
    settle = res;
    fail = rej;
  });
  void result.catch(() => {
  });
  const out = new Transform({ transform: (c, _e, cb) => cb(null, c) });
  out.on("error", () => {
  });
  out.push(MAGIC);
  out.push(iv);
  sizeBytes = MAGIC.length + iv.length;
  hash.update(MAGIC);
  hash.update(iv);
  const gzip = createGzip();
  const limit = limiter(maxSizeBytes, () => {
  });
  const count = new Transform({
    transform(chunk, _enc, cb) {
      sizeBytes += chunk.length;
      hash.update(chunk);
      cb(null, chunk);
    }
  });
  const onError = (err) => {
    fail(err);
    out.destroy(err instanceof Error ? err : new Error(String(err)));
  };
  source.on("error", onError);
  gzip.on("error", onError);
  cipher.on("error", onError);
  limit.on("error", onError);
  cipher.on("end", () => {
    try {
      const tag = cipher.getAuthTag();
      sizeBytes += tag.length;
      hash.update(tag);
      out.end(tag);
      settle({ sizeBytes, checksum: hash.digest("hex") });
    } catch (err) {
      onError(err);
    }
  });
  source.pipe(gzip).pipe(cipher).pipe(limit).pipe(count);
  count.on("data", (c) => out.write(c));
  count.on("error", onError);
  return { stream: out, result };
}

// src/backup/engine-postgres.ts
import { spawn } from "child_process";
function sanitizeStderr(raw, max = 1e3) {
  return raw.replace(/postgres(?:ql)?:\/\/[^\s"']+/gi, "postgresql://***").replace(/(password|PGPASSWORD)\s*=\s*\S+/gi, "$1=***").trim().slice(0, max);
}
function connectionEnv(databaseUrl) {
  let u;
  try {
    u = new URL(databaseUrl);
  } catch {
    throw new Error("databaseUrl nie jest prawid\u0142owym connection stringiem");
  }
  const env = {};
  if (u.hostname) env.PGHOST = decodeURIComponent(u.hostname);
  if (u.port) env.PGPORT = u.port;
  if (u.username) env.PGUSER = decodeURIComponent(u.username);
  if (u.password) env.PGPASSWORD = decodeURIComponent(u.password);
  const db = u.pathname.replace(/^\//, "");
  if (db) env.PGDATABASE = decodeURIComponent(db);
  const sslmode = u.searchParams.get("sslmode");
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}
var PostgresDumpEngine = class {
  constructor(opts) {
    this.opts = opts;
    this.label = "pg_dump/gzip/aes-256-gcm";
  }
  start() {
    const bin = this.opts.binary ?? "pg_dump";
    const args = this.opts.args ?? ["--no-owner", "--no-acl"];
    const child = spawn(bin, args, {
      env: { ...process.env, ...connectionEnv(this.opts.databaseUrl) },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stderr = "";
    child.stderr.on("data", (c) => {
      stderr = (stderr + String(c)).slice(-4e3);
    });
    const done = new Promise((resolve, reject) => {
      child.on("error", (err) => {
        reject(
          new Error(
            `Nie uda\u0142o si\u0119 uruchomi\u0107 ${bin}: ${err.message}. Sprawd\u017A, czy pg_dump jest zainstalowany i w PATH.`
          )
        );
      });
      child.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`${bin} zako\u0144czy\u0142 si\u0119 kodem ${code}: ${sanitizeStderr(stderr)}`));
      });
    });
    return {
      stream: child.stdout,
      done,
      abort: () => {
        try {
          child.kill("SIGTERM");
        } catch {
        }
      }
    };
  }
};
function createPostgresEngine(databaseUrl) {
  return new PostgresDumpEngine({ databaseUrl });
}

// src/backup/restore.ts
import { createDecipheriv, createHash as createHash2 } from "crypto";
import { createGunzip } from "zlib";
import { Transform as Transform2 } from "stream";
import { pipeline } from "stream/promises";
var IV_BYTES2 = 12;
var AUTH_TAG_BYTES = 16;
var HEADER_BYTES = MAGIC.length + IV_BYTES2;
var InvalidArtifactError = class extends Error {
  constructor(message) {
    super(message);
    this.name = "InvalidArtifactError";
  }
};
var ArtifactAuthenticationError = class extends Error {
  constructor() {
    super(
      "Nie uda\u0142o si\u0119 uwierzytelni\u0107 artefaktu. Najcz\u0119stsze przyczyny: z\u0142y klucz szyfruj\u0105cy albo uszkodzony/obci\u0119ty plik."
    );
    this.name = "ArtifactAuthenticationError";
  }
};
var DecryptTransform = class extends Transform2 {
  constructor(key) {
    super();
    this.key = key;
    this.buf = Buffer.alloc(0);
    this.decipher = null;
  }
  _transform(chunk, _enc, cb) {
    this.buf = Buffer.concat([this.buf, chunk]);
    if (!this.decipher) {
      if (this.buf.length < HEADER_BYTES) {
        cb();
        return;
      }
      const magic = this.buf.subarray(0, MAGIC.length);
      if (!magic.equals(MAGIC)) {
        cb(
          new InvalidArtifactError(
            `To nie jest artefakt Lunora \u2014 oczekiwano magii ${JSON.stringify(
              MAGIC.toString("utf8")
            )}, jest ${JSON.stringify(magic.toString("utf8").replace(/[^\x20-\x7e]/g, "?"))}.`
          )
        );
        return;
      }
      const iv = this.buf.subarray(MAGIC.length, HEADER_BYTES);
      this.decipher = createDecipheriv("aes-256-gcm", this.key, iv);
      this.buf = this.buf.subarray(HEADER_BYTES);
    }
    if (this.buf.length > AUTH_TAG_BYTES) {
      const ciphertext = this.buf.subarray(0, this.buf.length - AUTH_TAG_BYTES);
      this.buf = this.buf.subarray(this.buf.length - AUTH_TAG_BYTES);
      try {
        this.push(this.decipher.update(ciphertext));
      } catch (err) {
        cb(err);
        return;
      }
    }
    cb();
  }
  _flush(cb) {
    if (!this.decipher) {
      cb(
        new InvalidArtifactError(
          `Artefakt jest kr\xF3tszy ni\u017C nag\u0142\xF3wek (${HEADER_BYTES} B) \u2014 plik jest obci\u0119ty albo pusty.`
        )
      );
      return;
    }
    if (this.buf.length !== AUTH_TAG_BYTES) {
      cb(
        new InvalidArtifactError(
          `Artefakt jest obci\u0119ty: zosta\u0142o ${this.buf.length} B zamiast ${AUTH_TAG_BYTES} B znacznika uwierzytelniaj\u0105cego.`
        )
      );
      return;
    }
    try {
      this.decipher.setAuthTag(this.buf);
      this.push(this.decipher.final());
      cb();
    } catch {
      cb(new ArtifactAuthenticationError());
    }
  }
};
function hasher(hash) {
  return new Transform2({
    transform(chunk, _enc, cb) {
      hash.update(chunk);
      cb(null, chunk);
    }
  });
}
async function restoreArtifact(opts) {
  const key = parseEncryptionKey(opts.encryptionKeyHex);
  const hash = createHash2("sha256");
  let sizeBytes = 0;
  let plaintextBytes = 0;
  const counter = new Transform2({
    transform(chunk, _enc, cb) {
      sizeBytes += chunk.length;
      cb(null, chunk);
    }
  });
  const sink = opts.sink ?? new Transform2({
    transform(_chunk, _enc, cb) {
      cb();
    }
  });
  const counted = new Transform2({
    transform(chunk, _enc, cb) {
      plaintextBytes += chunk.length;
      cb(null, chunk);
    }
  });
  try {
    await pipeline(
      opts.source,
      hasher(hash),
      counter,
      new DecryptTransform(key),
      createGunzip(),
      counted,
      sink
    );
  } catch (err) {
    if (err instanceof InvalidArtifactError || err instanceof ArtifactAuthenticationError) {
      throw err;
    }
    const message = err instanceof Error ? err.message : String(err);
    if (/unable to authenticate|unsupported state/i.test(message)) {
      throw new ArtifactAuthenticationError();
    }
    throw err;
  }
  const checksum = hash.digest("hex");
  if (opts.expectedChecksum && opts.expectedChecksum !== checksum) {
    throw new InvalidArtifactError(
      `Suma kontrolna si\u0119 nie zgadza: oczekiwano ${opts.expectedChecksum}, policzono ${checksum}. Artefakt jest uszkodzony albo podmieniony.`
    );
  }
  return { checksum, sizeBytes, plaintextBytes };
}

// src/backup/index.ts
var DEFAULT_CHECK_INTERVAL_MS = 5 * 6e4;
var HEARTBEAT_INTERVAL_MS = 6e4;
function inertAgent(reason, logger) {
  logger?.(`[lunor:backup] modu\u0142 nieaktywny: ${reason}`);
  return {
    start: () => {
    },
    stop: () => {
    },
    tick: async () => {
    },
    enabled: false
  };
}
function createBackup(opts) {
  const log = (msg, err) => opts.logger?.(msg, err);
  if (!opts.apiKey || !opts.apiSecret) {
    return inertAgent("brak apiKey/apiSecret", opts.logger);
  }
  if (!opts.engine && !opts.databaseUrl) {
    return inertAgent("brak databaseUrl (i nie podano w\u0142asnego silnika)", opts.logger);
  }
  if (!opts.encryptionKey) {
    return inertAgent(
      "brak encryptionKey \u2014 odmawiam wysy\u0142ki niezaszyfrowanej kopii",
      opts.logger
    );
  }
  try {
    parseEncryptionKey(opts.encryptionKey);
  } catch {
    return inertAgent("encryptionKey nie jest 64-znakowym hexem", opts.logger);
  }
  const client = new BackupClient({
    apiKey: opts.apiKey,
    apiSecret: opts.apiSecret,
    endpoint: opts.endpoint,
    fetchImpl: opts.fetchImpl,
    logger: opts.logger
  });
  const state = new BackupStateStore(opts.statePath, opts.logger);
  const engine = opts.engine ?? createPostgresEngine(opts.databaseUrl);
  let timer = null;
  let running = false;
  let abortCurrent = null;
  async function upload(run, stream) {
    const res = await fetchOrGlobal()(run.uploadUrl, {
      method: "PUT",
      body: stream,
      // Node wymaga duplex przy strumieniowym ciele żądania.
      ...{ duplex: "half" },
      headers: { "Content-Type": "application/octet-stream" }
    });
    if (!res.ok) {
      throw new Error(`Upload artefaktu nie powi\xF3d\u0142 si\u0119 (HTTP ${res.status})`);
    }
  }
  function fetchOrGlobal() {
    return opts.fetchImpl ?? globalThis.fetch;
  }
  async function performRun(trigger) {
    const started = await client.startRun(engine.label, trigger);
    if (!started) return;
    state.update({ lastAttemptAt: (/* @__PURE__ */ new Date()).toISOString() });
    let heartbeat = null;
    let dump = null;
    try {
      dump = engine.start();
      abortCurrent = dump.abort;
      heartbeat = setInterval(() => {
        void client.heartbeat(started.runId);
      }, HEARTBEAT_INTERVAL_MS);
      heartbeat.unref?.();
      const maxBytes = Math.max(1, started.maxSizeMb) * 1024 * 1024;
      const { stream, result } = buildArtifactStream(
        dump.stream,
        opts.encryptionKey,
        maxBytes
      );
      await upload(started, stream);
      const [artifact] = await Promise.all([result, dump.done]);
      await client.finishRun(started.runId, {
        status: "UPLOADED",
        sizeBytes: artifact.sizeBytes,
        checksum: artifact.checksum
      });
      state.update({ lastSuccessAt: (/* @__PURE__ */ new Date()).toISOString() });
      log(`[lunor:backup] kopia wys\u0142ana (${artifact.sizeBytes} B)`);
    } catch (err) {
      dump?.abort();
      const message = err instanceof Error ? err.message : String(err);
      await client.finishRun(started.runId, { status: "FAILED", error: message });
      log("[lunor:backup] przebieg nieudany", err);
    } finally {
      if (heartbeat) clearInterval(heartbeat);
      abortCurrent = null;
    }
  }
  async function tick() {
    if (running) return;
    running = true;
    try {
      const config = await client.fetchConfig();
      if (config?.encryptionKeyFingerprint) {
        const mine = keyFingerprint(opts.encryptionKey);
        if (mine !== config.encryptionKeyFingerprint) {
          log(
            "[lunor:backup] \u26A0\uFE0F odcisk klucza r\xF3\u017Cni si\u0119 od zapisanego w Lunorze \u2014 starsze kopie mog\u0105 by\u0107 nieodczytywalne tym kluczem"
          );
        }
      }
      const decision = decide({
        config,
        state: state.get(),
        now: /* @__PURE__ */ new Date(),
        seed: opts.apiKey
      });
      if (!decision.run) return;
      if (decision.trigger === "MANUAL" && config?.runNowRequestedAt) {
        state.update({ handledRunNowAt: config.runNowRequestedAt });
      }
      await performRun(decision.trigger);
    } catch (err) {
      log("[lunor:backup] cykl zako\u0144czony b\u0142\u0119dem (ignoruj\u0119)", err);
    } finally {
      running = false;
    }
  }
  return {
    enabled: true,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void tick();
      }, opts.checkIntervalMs ?? DEFAULT_CHECK_INTERVAL_MS);
      timer.unref?.();
      void tick();
    },
    stop() {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      abortCurrent?.();
    },
    tick
  };
}
export {
  ArtifactAuthenticationError,
  InvalidArtifactError,
  MAGIC,
  createBackup,
  createPostgresEngine,
  decide,
  jitterMinutes,
  keyFingerprint,
  parseEncryptionKey,
  restoreArtifact
};
//# sourceMappingURL=index.mjs.map