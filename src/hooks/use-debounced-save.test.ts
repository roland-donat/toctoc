import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createDebouncedSaver, type SaveState } from "./use-debounced-save"

const DELAY = 600

function deferred() {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe("debounced saver", () => {
  it("sends only the latest version once the delay has passed", async () => {
    const sent: string[] = []
    const saver = createDebouncedSaver<string>({ delayMs: DELAY, save: async (p) => void sent.push(p) })
    saver.schedule("a")
    saver.schedule("ab")
    await vi.advanceTimersByTimeAsync(DELAY - 1)
    expect(sent).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(sent).toEqual(["ab"])
  })

  it("sends the edit still waiting when the screen is left before the delay (flush on unmount)", async () => {
    const sent: string[] = []
    const saver = createDebouncedSaver<string>({ delayMs: DELAY, save: async (p) => void sent.push(p) })
    saver.schedule("last edit")
    await vi.advanceTimersByTimeAsync(100)
    saver.flush()
    await vi.runAllTimersAsync()
    expect(sent).toEqual(["last edit"])
    // Nothing waits any more: a second flush sends nothing.
    saver.flush()
    await vi.runAllTimersAsync()
    expect(sent).toEqual(["last edit"])
  })

  it("does not show Enregistré for an older version while a newer edit is waiting", async () => {
    const states: SaveState[] = []
    const first = deferred()
    const sent: string[] = []
    const saver = createDebouncedSaver<string>({
      delayMs: DELAY,
      save: (p) => {
        sent.push(p)
        return sent.length === 1 ? first.promise : Promise.resolve()
      },
      onState: (s) => states.push(s),
    })
    saver.schedule("v1")
    await vi.advanceTimersByTimeAsync(DELAY)
    saver.schedule("v2")
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(states.at(-1)).toBe("pending")
    await vi.advanceTimersByTimeAsync(DELAY)
    expect(sent).toEqual(["v1", "v2"])
    expect(states.at(-1)).toBe("saved")
  })

  it("sends two versions one after the other, never both in flight", async () => {
    const first = deferred()
    const started: string[] = []
    const saver = createDebouncedSaver<string>({
      delayMs: DELAY,
      save: (p) => {
        started.push(p)
        return p === "v1" ? first.promise : Promise.resolve()
      },
    })
    saver.schedule("v1")
    saver.flush()
    saver.schedule("v2")
    saver.flush()
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(["v1"])
    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    expect(started).toEqual(["v1", "v2"])
  })

  it("cancel drops the waiting version", async () => {
    const sent: string[] = []
    const saver = createDebouncedSaver<string>({ delayMs: DELAY, save: async (p) => void sent.push(p) })
    saver.schedule("draft")
    saver.cancel()
    saver.flush()
    await vi.runAllTimersAsync()
    expect(sent).toEqual([])
  })
})
