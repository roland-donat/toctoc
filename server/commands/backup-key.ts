// `bin/toctoc backup-key <identity file>`: creates the age key pair of the backups. Run it on the administrator's
// own computer, never on the server: the identity file stays there, only the public key goes into the config.
import { existsSync } from "node:fs"
import { writeFile } from "node:fs/promises"
import { generateIdentity, identityToRecipient } from "age-encryption"

const HELP = `Usage: bin/toctoc backup-key <identity file>

Writes a new age identity (private key) to <identity file> (mode 600, never overwritten) and prints the
matching public key (age1...) to put in the server config as backup_recipient. Keep the identity file off the
server, in a safe place: without it no backup can be restored.`

export async function backupKeyCommand(args: string[]): Promise<number> {
  const [file] = args
  if (!file || args.length !== 1 || file.startsWith("--")) {
    console.error(HELP)
    return 2
  }
  if (existsSync(file)) {
    console.error(`backup-key: ${file} already exists; choose another path.`)
    return 1
  }
  const identity = await generateIdentity()
  const recipient = await identityToRecipient(identity)
  await writeFile(file, `# TOCTOC backup identity, created ${new Date().toISOString()}\n# public key: ${recipient}\n${identity}\n`, {
    mode: 0o600,
    flag: "wx",
  })
  console.log(recipient)
  return 0
}
