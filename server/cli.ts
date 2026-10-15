// Administration commands, run through bin/toctoc. Each command reads the same configuration as the server.

import { backupKeyCommand } from "./commands/backup-key.ts"
import { backupCommand } from "./commands/backup.ts"
import { purgeCommand } from "./commands/purge.ts"
import { restoreCommand } from "./commands/restore.ts"
import { setPasswordCommand } from "./commands/set-password.ts"

type Command = (args: string[]) => Promise<number>

const commands: Record<string, Command> = {
  backup: backupCommand,
  "backup-key": backupKeyCommand,
  purge: purgeCommand,
  restore: restoreCommand,
  "set-password": setPasswordCommand,
}

async function main(argv: string[]): Promise<number> {
  const [name, ...args] = argv
  const command = name ? commands[name] : undefined
  if (!command) {
    const known = Object.keys(commands).sort().join(", ") || "(none yet)"
    console.error(`Usage: bin/toctoc <command>\nCommands: ${known}`)
    return 2
  }
  return command(args)
}

process.exitCode = await main(process.argv.slice(2))
