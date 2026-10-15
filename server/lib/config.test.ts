import { chmodSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { ConfigError, loadConfig, parseConfig, readEnvFile, REPO_ROOT } from "./config.ts"

const outside = () => mkdtempSync(join(tmpdir(), "toctoc-cfg-"))

describe("parseConfig", () => {
  it("refuses a data_dir inside the repository with an explicit message", () => {
    expect(() => parseConfig({ commune_insee: "93014", data_dir: "./data" }, { configDir: REPO_ROOT })).toThrowError(
      /data_dir .* is inside the repository/,
    )
  })

  it("requires the INSEE code of the commune and refuses a postal code", () => {
    expect(() => parseConfig({ data_dir: outside() }, { configDir: outside() })).toThrowError(/commune_insee is required/)
    expect(() => parseConfig({ commune_insee: "9339", data_dir: outside() }, { configDir: outside() })).toThrowError(
      /INSEE commune code/,
    )
    expect(parseConfig({ commune_insee: "93014", data_dir: outside() }, { configDir: outside() }).communeInsee).toBe("93014")
  })

  it("refuses a missing data_dir", () => {
    expect(() => parseConfig({}, { configDir: outside() })).toThrowError(ConfigError)
    expect(() => parseConfig({}, { configDir: outside() })).toThrowError(/data_dir/)
  })

  it("refuses a backup_dir inside the repository", () => {
    expect(() =>
      parseConfig({ commune_insee: "93014", data_dir: outside(), backup_dir: join(REPO_ROOT, "backups") }, { configDir: outside() }),
    ).toThrowError(/backup_dir .* is inside the repository/)
  })

  it("accepts a data_dir outside the repository and resolves it against the config file", () => {
    const dir = outside()
    const config = parseConfig({ commune_insee: "93014", data_dir: "data", public_origin: "https://toctoc.example.fr" }, { configDir: dir })
    expect(config.dataDir).toBe(join(dir, "data"))
    expect(config.backupDir).toBe(join(dir, "data", "backups"))
    expect(config.publicOrigin).toBe("https://toctoc.example.fr")
    expect(config.server).toEqual({ port: 3000, host: "127.0.0.1" })
  })
})

describe("loadConfig", () => {
  it("reads the file named by TOCTOC_CONFIG", () => {
    const dir = outside()
    const file = join(dir, "config.json")
    writeFileSync(file, JSON.stringify({ commune_insee: "93014", data_dir: join(dir, "d"), server: { port: 4123 } }))
    expect(loadConfig({ TOCTOC_CONFIG: file, TOCTOC_ENV_FILE: writeEnv(dir, "") }).server.port).toBe(4123)
  })

  it("fails with a clear message when the file does not exist", () => {
    const dir = outside()
    expect(() => loadConfig({ TOCTOC_CONFIG: join(dir, "missing.json"), TOCTOC_ENV_FILE: writeEnv(dir, "") })).toThrowError(
      /Configuration file not found/,
    )
  })

  it("runs on environment variables alone, without a config file", () => {
    const dir = outside()
    const config = loadConfig({
      TOCTOC_ENV_FILE: writeEnv(dir, ""),
      TOCTOC_COMMUNE_INSEE: "93014",
      TOCTOC_DATA_DIR: join(dir, "d"),
      TOCTOC_PORT: "4200",
      TOCTOC_PUBLIC_ORIGIN: "https://toctoc.example.org",
    })
    expect(config.dataDir).toBe(join(dir, "d"))
    expect(config.server.port).toBe(4200)
    expect(config.publicOrigin).toBe("https://toctoc.example.org")
  })

  it("lets the environment override the file, and the process environment override the .env file", () => {
    const dir = outside()
    const file = join(dir, "config.json")
    writeFileSync(file, JSON.stringify({ commune_insee: "93014", data_dir: join(dir, "d"), server: { port: 4123 } }))
    const envFile = writeEnv(dir, "TOCTOC_PORT=4300\nTOCTOC_HOST=0.0.0.0\n")
    const config = loadConfig({ TOCTOC_CONFIG: file, TOCTOC_ENV_FILE: envFile, TOCTOC_HOST: "127.0.0.2" })
    expect(config.server).toEqual({ port: 4300, host: "127.0.0.2" })
  })

  it("refuses a malformed port", () => {
    const dir = outside()
    expect(() => loadConfig({ TOCTOC_ENV_FILE: writeEnv(dir, ""), TOCTOC_COMMUNE_INSEE: "93014", TOCTOC_DATA_DIR: dir, TOCTOC_PORT: "80a" })).toThrowError(
      /TOCTOC_PORT/,
    )
  })
})

function writeEnv(dir: string, content: string): string {
  const file = join(dir, ".env")
  writeFileSync(file, content)
  chmodSync(file, 0o600)
  return file
}

describe("readEnvFile", () => {
  it("refuses a .env file readable by other accounts, since it may hold secrets", () => {
    const dir = outside()
    const file = writeEnv(dir, "TOCTOC_PORT=1\n")
    chmodSync(file, 0o644)
    expect(() => readEnvFile({ TOCTOC_ENV_FILE: file })).toThrowError(/readable by other accounts/)
  })

  it("fails when the named file does not exist", () => {
    expect(() => readEnvFile({ TOCTOC_ENV_FILE: join(outside(), "missing.env") })).toThrowError(/not found/)
  })
})
