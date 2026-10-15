// `bin/toctoc restore <backup file> --identity <key file> [--force]`: restores a backup into data_dir.
// The server must be stopped first.
import { loadConfig, ConfigError } from "../lib/config.ts"
import { RestoreError, restoreBackup } from "../services/restore.ts"

const HELP = `Usage: bin/toctoc restore <backup file> --identity <key file> [--force]

Stop the server first. Decrypts the backup with the age identity (AGE-SECRET-KEY-...), checks it is a valid
SQLite database, and installs it as <data_dir>/toctoc.db. Refuses to replace an existing database unless --force
is given. Delete the key file from the server once the restoration is done.`

const MESSAGES: Record<RestoreError["code"], string> = {
  target_exists: "a database already exists in data_dir; pass --force to replace it.",
  decryption_failed: "the backup cannot be decrypted with this identity.",
  not_a_database: "the decrypted file is not a valid SQLite database; nothing was replaced.",
  no_identity: "no AGE-SECRET-KEY- line found in the identity file.",
}

export async function restoreCommand(args: string[]): Promise<number> {
  const identityIndex = args.indexOf("--identity")
  const identityFile = identityIndex >= 0 ? args[identityIndex + 1] : undefined
  const positional = args.filter((a, i) => !a.startsWith("--") && i !== identityIndex + 1)
  if (args.includes("--help") || positional.length !== 1 || !identityFile) {
    console.error(HELP)
    return args.includes("--help") ? 0 : 2
  }
  try {
    const config = loadConfig()
    const target = await restoreBackup({
      backupFile: positional[0]!,
      identityFile,
      dataDir: config.dataDir,
      force: args.includes("--force"),
    })
    console.error(`Restored into ${target}. Start the server, then delete the key file from this machine.`)
    return 0
  } catch (err) {
    if (err instanceof ConfigError) console.error(`restore: ${err.message}`)
    else if (err instanceof RestoreError) console.error(`restore: ${MESSAGES[err.code]}`)
    else throw err
    return 1
  }
}
