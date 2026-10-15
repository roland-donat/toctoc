// `bin/toctoc set-password`: defines the administrator password (KTD5).
import { resolve } from "node:path"
import type { Db } from "../db/index.ts"
import { openDatabase } from "../db/index.ts"
import { hashPassword, MIN_PASSWORD_LENGTH, setAdminPassword } from "../lib/auth.ts"
import { ConfigError, loadConfig } from "../lib/config.ts"
import { logInfo } from "../lib/log.ts"

export type SetPasswordResult = "ok" | "too_short"

/** Hashes and stores the password; every existing session is deleted. */
export async function applyNewPassword(db: Db, password: string, now: Date): Promise<SetPasswordResult> {
  if (password.length < MIN_PASSWORD_LENGTH) return "too_short"
  setAdminPassword(db, await hashPassword(password), now)
  return "ok"
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
  // Drop only the trailing line break added by echo or a here-string.
  return Buffer.concat(chunks).toString("utf-8").replace(/\r?\n$/, "")
}

/** Reads one line from the terminal without echoing it. Resolves null on Ctrl-C or Ctrl-D. */
function promptHidden(question: string): Promise<string | null> {
  return new Promise((resolvePrompt) => {
    const stdin = process.stdin
    process.stderr.write(question)
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf-8")
    let value = ""
    const finish = (result: string | null) => {
      stdin.setRawMode(false)
      stdin.pause()
      stdin.removeListener("data", onData)
      process.stderr.write("\n")
      resolvePrompt(result)
    }
    const onData = (data: string) => {
      for (const ch of data) {
        if (ch === "\r" || ch === "\n") return finish(value)
        if (ch === "\u0003" || ch === "\u0004") return finish(null)
        if (ch === "\u007f" || ch === "\b") value = value.slice(0, -1)
        else value += ch
      }
    }
    stdin.on("data", onData)
  })
}

async function readPassword(): Promise<string | null> {
  if (!process.stdin.isTTY) return readStdin()
  const first = await promptHidden("Nouveau mot de passe administrateur : ")
  if (first === null) return null
  const second = await promptHidden("Confirmer le mot de passe : ")
  if (second === null) return null
  if (first !== second) {
    console.error("The two passwords differ; nothing was changed.")
    return null
  }
  return first
}

export async function setPasswordCommand(_args: string[]): Promise<number> {
  let config
  try {
    config = loadConfig()
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`set-password: ${err.message}`)
      return 1
    }
    throw err
  }

  const password = await readPassword()
  if (password === null) return 1

  const { db, sqlite } = openDatabase(resolve(config.dataDir, "toctoc.db"))
  try {
    const result = await applyNewPassword(db, password, new Date())
    if (result === "too_short") {
      console.error(`Password refused: at least ${MIN_PASSWORD_LENGTH} characters are required.`)
      return 1
    }
    logInfo("admin_password_set")
    console.error("Password updated; all existing sessions were closed.")
    return 0
  } finally {
    sqlite.close()
  }
}
