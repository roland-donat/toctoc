// Debounced auto-save (no save button, CLAUDE.md conventions). The latest payload is kept until it is sent: an
// edit restarts the delay, leaving the screen (unmount) or the page (pagehide) sends what is still waiting, and
// "Enregistré" is shown only once the latest version is stored. Saves run one after the other, in edit order.
import { useEffect, useState } from "react"

/** idle: nothing to save; pending: waiting for the delay; saving: sent; saved: the latest version is stored. */
export type SaveState = "idle" | "pending" | "saving" | "saved" | "error"

export interface DebouncedSaver<T> {
  /** Records a new version and restarts the delay. */
  schedule(payload: T): void
  /** Sends the waiting version now, if any. */
  flush(): void
  /** Drops the waiting version without sending it (it is no longer to be saved). */
  cancel(): void
  /** Replaces the save function used from the next send on. */
  setSave(save: (payload: T) => Promise<unknown>): void
}

export interface DebouncedSaverOptions<T> {
  delayMs: number
  save: (payload: T) => Promise<unknown>
  onState?: (state: SaveState) => void
}

export function createDebouncedSaver<T>({ delayMs, save, onState }: DebouncedSaverOptions<T>): DebouncedSaver<T> {
  let saveFn = save
  let latest: { payload: T } | null = null
  let version = 0
  let timer: ReturnType<typeof setTimeout> | null = null
  // Saves are chained so two requests in flight never reach the server out of order.
  let chain: Promise<unknown> = Promise.resolve()

  const clearTimer = () => {
    if (timer !== null) clearTimeout(timer)
    timer = null
  }

  function flush(): void {
    clearTimer()
    if (latest === null) return
    const { payload } = latest
    latest = null
    const sent = version
    onState?.("saving")
    chain = chain
      .then(() => saveFn(payload))
      .then(
        () => {
          // A newer edit made meanwhile is not stored yet: keep showing it as waiting.
          if (sent === version) onState?.("saved")
        },
        () => {
          if (sent === version) onState?.("error")
        },
      )
  }

  return {
    schedule(payload) {
      latest = { payload }
      version++
      clearTimer()
      timer = setTimeout(flush, delayMs)
      onState?.("pending")
    },
    flush,
    cancel() {
      clearTimer()
      latest = null
      version++
      onState?.("idle")
    },
    setSave(next) {
      saveFn = next
    },
  }
}

/**
 * React binding: one saver for the component's life, flushed on unmount and on pagehide. `save` may change
 * between renders; the latest one is used.
 */
export function useDebouncedSave<T>(save: (payload: T) => Promise<unknown>, delayMs: number) {
  const [state, setState] = useState<SaveState>("idle")
  const [saver] = useState(() => createDebouncedSaver<T>({ delayMs, save, onState: setState }))
  useEffect(() => {
    saver.setSave(save)
  }, [saver, save])
  useEffect(() => {
    const onPageHide = () => saver.flush()
    window.addEventListener("pagehide", onPageHide)
    return () => {
      window.removeEventListener("pagehide", onPageHide)
      saver.flush()
    }
  }, [saver])
  return { state, schedule: saver.schedule, flush: saver.flush, cancel: saver.cancel }
}
