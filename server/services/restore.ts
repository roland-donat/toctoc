// Restores an age-encrypted backup into the data directory (U15). The private key is brought to the server only
// for the restoration; the server must be stopped.
import { existsSync } from "node:fs"
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { join } from "node:path"
import Database from "better-sqlite3"
import { Decrypter } from "age-encryption"

export type RestoreErrorCode = "target_exists" | "decryption_failed" | "not_a_database" | "no_identity"

export class RestoreError extends Error {
  override name = "RestoreError"
  readonly code: RestoreErrorCode

  constructor(code: RestoreErrorCode) {
    super(code)
    this.code = code
  }
}

export interface RestoreOptions {
  backupFile: string
  /** File holding the AGE-SECRET-KEY-... identity (comment lines allowed). */
  identityFile: string
  dataDir: string
  /** Replace an existing database. */
  force?: boolean
}

async function removeWithSidecars(file: string): Promise<void> {
  for (const suffix of ["", "-wal", "-shm"]) await rm(`${file}${suffix}`, { force: true })
}

/** Decrypts, checks the SQLite image, then installs it as <dataDir>/toctoc.db. Returns the database path. */
export async function restoreBackup(options: RestoreOptions): Promise<string> {
  const target = join(options.dataDir, "toctoc.db")
  if (existsSync(target) && options.force !== true) throw new RestoreError("target_exists")

  const identity = (await readFile(options.identityFile, "utf-8"))
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("AGE-SECRET-KEY-"))
  if (!identity) throw new RestoreError("no_identity")

  const content = await readFile(options.backupFile)
  let image: Uint8Array = content
  if (options.backupFile.endsWith(".age")) {
    const decrypter = new Decrypter()
    decrypter.addIdentity(identity)
    try {
      image = await decrypter.decrypt(content)
    } catch {
      throw new RestoreError("decryption_failed")
    }
  }

  await mkdir(options.dataDir, { recursive: true, mode: 0o700 })
  const staging = `${target}.restoring`
  await writeFile(staging, image, { mode: 0o600 })
  try {
    const check = new Database(staging, { readonly: true })
    const ok = check.pragma("integrity_check", { simple: true }) === "ok"
    check.close()
    if (!ok) throw new RestoreError("not_a_database")
  } catch (err) {
    await removeWithSidecars(staging)
    throw err instanceof RestoreError ? err : new RestoreError("not_a_database")
  }
  // Opening the WAL-mode image for the check leaves -wal/-shm files next to the staging copy.
  for (const suffix of ["-wal", "-shm"]) await rm(`${staging}${suffix}`, { force: true })
  for (const suffix of ["-wal", "-shm"]) await rm(`${target}${suffix}`, { force: true })
  await rename(staging, target)
  return target
}
