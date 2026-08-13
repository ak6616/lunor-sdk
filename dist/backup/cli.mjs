#!/usr/bin/env node

// src/backup/cli.ts
import { createReadStream, createWriteStream, readFileSync } from "fs";
import { spawn as spawn2 } from "child_process";

// src/backup/restore.ts
import { createDecipheriv, createHash as createHash2 } from "crypto";
import { createGunzip } from "zlib";
import { Transform as Transform2 } from "stream";
import { pipeline } from "stream/promises";

// src/backup/pipeline.ts
import { createCipheriv, createHash, randomBytes } from "crypto";
import { createGzip } from "zlib";
import { Transform } from "stream";
var MAGIC = Buffer.from("LUNORBK1", "utf8");
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

// src/backup/restore.ts
var IV_BYTES = 12;
var AUTH_TAG_BYTES = 16;
var HEADER_BYTES = MAGIC.length + IV_BYTES;
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

// src/backup/engine-postgres.ts
import { spawn } from "child_process";
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

// src/backup/cli.ts
var USAGE = `
lunor-backup \u2014 odtwarzanie kopii Lunora

  lunor-backup verify  --in <artefakt>  [--checksum <sha256>]
  lunor-backup restore --in <artefakt>  --out <plik.sql>
  lunor-backup restore --in <artefakt>  --to-database

Argumenty:
  --in <plik>        artefakt (.dump.gz.enc); "-" czyta ze standardowego wej\u015Bcia
  --out <plik>       dok\u0105d zapisa\u0107 odszyfrowany zrzut SQL; "-" pisze na stdout
  --to-database      wpuszcza zrzut prosto do psql (wymaga DATABASE_URL)
  --checksum <hex>   oczekiwana suma sha256 artefaktu (z panelu Lunora)
  --key-file <plik>  plik z kluczem szyfruj\u0105cym (64 znaki hex)

Klucz szyfruj\u0105cy:
  Z LUNOR_BACKUP_KEY albo z --key-file. NIE ma opcji --key, bo argumenty
  procesu wida\u0107 w \`ps\` dla ka\u017Cdego u\u017Cytkownika maszyny.

Baza docelowa (tylko --to-database):
  Z DATABASE_URL. UWAGA: zrzut nadpisuje istniej\u0105ce obiekty \u2014 kieruj go na
  \u015Bwie\u017C\u0105 baz\u0119, a nie na produkcj\u0119.

verify nie zapisuje niczego. Przepuszcza artefakt przez deszyfrator i gunzip,
wi\u0119c dowodzi, \u017Ce kopia jest odczytywalna TYM kluczem. To jest test do
uruchamiania regularnie, nie po awarii.
`.trim();
function parseArgs(argv) {
  const args = { command: argv[0] ?? "", toDatabase: false };
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === void 0) throw new Error(`Brakuje warto\u015Bci dla ${a}`);
      return v;
    };
    switch (a) {
      case "--in":
        args.in = next();
        break;
      case "--out":
        args.out = next();
        break;
      case "--checksum":
        args.checksum = next();
        break;
      case "--key-file":
        args.keyFile = next();
        break;
      case "--to-database":
        args.toDatabase = true;
        break;
      case "--key":
        throw new Error(
          "Opcja --key nie istnieje celowo: argumenty procesu wida\u0107 w `ps`. U\u017Cyj zmiennej LUNOR_BACKUP_KEY albo --key-file."
        );
      default:
        throw new Error(`Nieznany argument: ${a}`);
    }
  }
  return args;
}
function resolveKey(args, env) {
  if (args.keyFile) return readFileSync(args.keyFile, "utf8").trim();
  const fromEnv = env.LUNOR_BACKUP_KEY?.trim();
  if (fromEnv) return fromEnv;
  throw new Error(
    "Brak klucza szyfruj\u0105cego. Ustaw LUNOR_BACKUP_KEY albo podaj --key-file."
  );
}
function openSource(path) {
  return path === "-" ? process.stdin : createReadStream(path);
}
function human(bytes) {
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  let v = bytes;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${u === 0 ? v : v.toFixed(1)} ${units[u]}`;
}
async function main(argv, env) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (err) {
    console.error(`B\u0142\u0105d: ${err.message}
`);
    console.error(USAGE);
    return 2;
  }
  if (args.command === "help" || args.command === "--help" || args.command === "-h" || !args.command) {
    console.log(USAGE);
    return args.command ? 0 : 2;
  }
  if (args.command !== "verify" && args.command !== "restore") {
    console.error(`Nieznane polecenie: ${args.command}
`);
    console.error(USAGE);
    return 2;
  }
  if (!args.in) {
    console.error("B\u0142\u0105d: brakuje --in\n");
    console.error(USAGE);
    return 2;
  }
  let key;
  try {
    key = resolveKey(args, env);
  } catch (err) {
    console.error(`B\u0142\u0105d: ${err.message}`);
    return 2;
  }
  let sink;
  let psql = null;
  if (args.command === "restore") {
    if (args.toDatabase) {
      const url = env.DATABASE_URL;
      if (!url) {
        console.error("B\u0142\u0105d: --to-database wymaga DATABASE_URL.");
        return 2;
      }
      psql = spawn2("psql", ["--quiet", "--no-psqlrc"], {
        env: { ...process.env, ...connectionEnv(url) },
        stdio: ["pipe", "inherit", "inherit"]
      });
      sink = psql.stdin;
    } else if (args.out) {
      sink = args.out === "-" ? process.stdout : createWriteStream(args.out);
    } else {
      console.error("B\u0142\u0105d: restore wymaga --out albo --to-database\n");
      console.error(USAGE);
      return 2;
    }
  }
  try {
    const result = await restoreArtifact({
      source: openSource(args.in),
      encryptionKeyHex: key,
      sink,
      expectedChecksum: args.checksum
    });
    if (psql) {
      const code = await new Promise((resolve) => psql.on("close", resolve));
      if (code !== 0) {
        console.error(`psql zako\u0144czy\u0142 si\u0119 kodem ${code} \u2014 odtwarzanie NIEUDANE.`);
        return 1;
      }
    }
    const co = args.command === "verify" ? "Artefakt poprawny" : "Odtworzono";
    console.error(
      `${co}: ${human(result.sizeBytes)} artefaktu \u2192 ${human(result.plaintextBytes)} zrzutu SQL`
    );
    console.error(`sha256: ${result.checksum}`);
    if (args.checksum) console.error("Suma kontrolna zgodna z podan\u0105.");
    return 0;
  } catch (err) {
    if (err?.code === "EPIPE") {
      psql?.kill();
      return 0;
    }
    console.error(`ODTWARZANIE NIEUDANE: ${err.message}`);
    psql?.kill();
    return 1;
  }
}
if (process.argv[1] && /lunor-backup|cli\.(t|j|mj|cj)s$/.test(process.argv[1])) {
  main(process.argv.slice(2), process.env).then((code) => process.exit(code)).catch((err) => {
    console.error(`B\u0142\u0105d krytyczny: ${err?.message ?? err}`);
    process.exit(1);
  });
}
export {
  main,
  parseArgs,
  resolveKey
};
//# sourceMappingURL=cli.mjs.map