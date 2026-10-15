import { existsSync, readFileSync, realpathSync, statSync } from "node:fs"
import { dirname, isAbsolute, relative, resolve } from "node:path"
import { parseEnv } from "node:util"
import { z } from "zod"
import { INSEE_CODE_PATTERN } from "../domain/commune.ts"

export interface AppConfig {
  /** INSEE code of the one commune this server covers (not its postal code). */
  communeInsee: string
  /** Directory holding the SQLite database and uploaded import files. Never inside the repository. */
  dataDir: string
  /** Only place where database copies may live (KTD15). Never inside the repository. */
  backupDir: string
  /**
   * age public key (age1...) the backups are encrypted to. The private key never lives on the server, so a copy of
   * the backup directory alone discloses nothing. Null only in development and tests.
   */
  backupRecipient: string | null
  /** Public origin (scheme + host) the app is served from, used for the Origin check (KTD5). */
  publicOrigin: string
  server: { port: number; host: string }
  routing: { osrmUrl: string; vroomUrl: string }
}

export class ConfigError extends Error {
  override name = "ConfigError"
}

export const REPO_ROOT = resolve(import.meta.dirname, "../..")

const rawConfigSchema = z.object({
  commune_insee: z
    .string({ required_error: "commune_insee is required (INSEE code of the commune, e.g. 93014, not its postal code)" })
    .regex(INSEE_CODE_PATTERN, "commune_insee must be an INSEE commune code such as 93014 (not a postal code)"),
  data_dir: z.string().min(1, "data_dir is required"),
  backup_dir: z.string().min(1).optional(),
  backup_recipient: z.string().regex(/^age1[0-9a-z]+$/, "backup_recipient must be an age public key (age1...)").optional(),
  public_origin: z.string().url().optional(),
  server: z
    .object({
      port: z.number().int().positive().optional(),
      host: z.string().min(1).optional(),
    })
    .optional(),
  routing: z
    .object({
      osrm_url: z.string().url().optional(),
      vroom_url: z.string().url().optional(),
    })
    .optional(),
})

/** Resolves symlinks of the longest existing prefix so a not-yet-created directory is still compared correctly. */
function realPathOrSelf(path: string): string {
  let current = path
  const suffix: string[] = []
  while (!existsSync(current)) {
    const parent = dirname(current)
    if (parent === current) return path
    suffix.unshift(relative(parent, current))
    current = parent
  }
  return resolve(realpathSync(current), ...suffix)
}

function isInside(child: string, parent: string): boolean {
  const rel = relative(realPathOrSelf(parent), realPathOrSelf(child))
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))
}

export function parseConfig(raw: unknown, opts: { configDir: string; repoRoot?: string }): AppConfig {
  const repoRoot = opts.repoRoot ?? REPO_ROOT
  const parsed = rawConfigSchema.safeParse(raw)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "config"}: ${i.message}`)
    throw new ConfigError(`Invalid configuration: ${issues.join("; ")}`)
  }
  const value = parsed.data
  const dataDir = resolve(opts.configDir, value.data_dir)
  const backupDir = resolve(opts.configDir, value.backup_dir ?? resolve(dataDir, "backups"))

  for (const [key, dir] of [
    ["data_dir", dataDir],
    ["backup_dir", backupDir],
  ] as const) {
    if (isInside(dir, repoRoot)) {
      throw new ConfigError(
        `${key} (${dir}) is inside the repository (${repoRoot}); nominative data must live outside it`,
      )
    }
  }

  const port = value.server?.port ?? 3000
  return {
    communeInsee: value.commune_insee,
    dataDir,
    backupDir,
    backupRecipient: value.backup_recipient ?? null,
    publicOrigin: value.public_origin ?? `http://127.0.0.1:${port}`,
    server: { port, host: value.server?.host ?? "127.0.0.1" },
    routing: {
      osrmUrl: value.routing?.osrm_url ?? "http://127.0.0.1:5000",
      vroomUrl: value.routing?.vroom_url ?? "http://127.0.0.1:3010",
    },
  }
}

/** Environment variables that override the config file, each with the file key it replaces. */
const ENV_OVERRIDES = {
  TOCTOC_COMMUNE_INSEE: ["commune_insee"],
  TOCTOC_DATA_DIR: ["data_dir"],
  TOCTOC_BACKUP_DIR: ["backup_dir"],
  TOCTOC_BACKUP_RECIPIENT: ["backup_recipient"],
  TOCTOC_PUBLIC_ORIGIN: ["public_origin"],
  TOCTOC_PORT: ["server", "port"],
  TOCTOC_HOST: ["server", "host"],
  TOCTOC_OSRM_URL: ["routing", "osrm_url"],
  TOCTOC_VROOM_URL: ["routing", "vroom_url"],
} as const satisfies Record<string, readonly string[]>

/**
 * Reads the `.env` file named by TOCTOC_ENV_FILE, or `.env` at the repository root, when it exists. It holds the
 * settings and secrets of one installation, never committed (.gitignore); a file readable by other accounts is
 * refused, since it may carry secrets.
 */
export function readEnvFile(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const path = env.TOCTOC_ENV_FILE ? resolve(env.TOCTOC_ENV_FILE) : resolve(REPO_ROOT, ".env")
  if (!existsSync(path)) {
    if (env.TOCTOC_ENV_FILE) throw new ConfigError(`Environment file not found: ${path}`)
    return {}
  }
  if ((statSync(path).mode & 0o007) !== 0) {
    throw new ConfigError(`Environment file ${path} is readable by other accounts: chmod 600 (or 640) it`)
  }
  return parseEnv(readFileSync(path, "utf-8")) as Record<string, string>
}

function setPath(target: Record<string, unknown>, path: readonly string[], value: unknown): void {
  let node = target
  for (const key of path.slice(0, -1)) {
    const child = node[key]
    node = typeof child === "object" && child !== null ? (child as Record<string, unknown>) : (node[key] = {})
  }
  node[path[path.length - 1] as string] = value
}

/**
 * Reads the configuration: the JSON file named by TOCTOC_CONFIG (or `config.json` at the repository root), then
 * the TOCTOC_* variables of the environment and of the `.env` file, which take precedence over it. The process
 * environment wins over the `.env` file. Without a file, TOCTOC_DATA_DIR is enough.
 */
export function loadConfig(processEnv: NodeJS.ProcessEnv = process.env): AppConfig {
  const env: NodeJS.ProcessEnv = { ...readEnvFile(processEnv), ...processEnv }
  const path = env.TOCTOC_CONFIG ? resolve(env.TOCTOC_CONFIG) : resolve(REPO_ROOT, "config.json")
  let raw: Record<string, unknown> = {}
  if (existsSync(path)) {
    try {
      raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>
    } catch {
      throw new ConfigError(`Configuration file is not valid JSON: ${path}`)
    }
  } else if (env.TOCTOC_CONFIG || !env.TOCTOC_DATA_DIR) {
    throw new ConfigError(`Configuration file not found: ${path} (see config.example.json or .env.example)`)
  }
  for (const [name, key] of Object.entries(ENV_OVERRIDES)) {
    const value = env[name]
    if (value === undefined || value === "") continue
    if (name === "TOCTOC_PORT") {
      if (!/^\d+$/.test(value)) throw new ConfigError(`${name} must be a port number`)
      setPath(raw, key, Number(value))
    } else {
      // Paths given in the environment are taken from the current directory, not from the config file.
      setPath(raw, key, name.endsWith("_DIR") ? resolve(value) : value)
    }
  }
  return parseConfig(raw, { configDir: dirname(path) })
}
