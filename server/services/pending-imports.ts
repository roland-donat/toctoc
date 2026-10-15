import { rm } from "node:fs/promises"

/** A simulated import waiting for confirmation, with the uploaded file stored under its id. */
export interface PendingImport {
  id: string
  filePath: string
}

/** Holds the latest simulation until it is confirmed; a new upload replaces (and deletes) the previous one. */
export class PendingImports<T extends PendingImport> {
  private current: T | null = null

  async put(pending: T): Promise<void> {
    const previous = this.current
    this.current = pending
    if (previous !== null && previous.id !== pending.id) await rm(previous.filePath, { force: true })
  }

  get(id: string): T | null {
    return this.current?.id === id ? this.current : null
  }

  /** Forgets a confirmed simulation; its file stays, it belongs to the import now. */
  forget(id: string): void {
    if (this.current?.id === id) this.current = null
  }
}
