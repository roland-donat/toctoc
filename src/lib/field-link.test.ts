import { describe, expect, it } from "vitest"
import { FIELD_LINK_KEY, forgetFieldToken, resolveFieldToken } from "@/lib/field-link"
import type { QueueStorage } from "@/lib/feedback-queue"

// Fictional tokens, in the format of the real ones.
const A = "tokenAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
const B = "tokenBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB"

function memoryStorage(initial: Record<string, string> = {}): QueueStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial))
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  }
}

describe("resolveFieldToken", () => {
  it("takes the token of the link opened and remembers it", () => {
    const storage = memoryStorage()
    expect(resolveFieldToken(`#${A}`, storage)).toBe(A)
    expect(storage.data.get(FIELD_LINK_KEY)).toBe(A)
  })

  it("finds the remembered token when the installed app opens without a fragment", () => {
    expect(resolveFieldToken("", memoryStorage({ [FIELD_LINK_KEY]: A }))).toBe(A)
  })

  it("lets a newly opened link replace the remembered one", () => {
    const storage = memoryStorage({ [FIELD_LINK_KEY]: A })
    expect(resolveFieldToken(`#${B}`, storage)).toBe(B)
    expect(storage.data.get(FIELD_LINK_KEY)).toBe(B)
  })

  it("ignores a remembered value that is not a token", () => {
    expect(resolveFieldToken("", memoryStorage({ [FIELD_LINK_KEY]: "<script>" }))).toBeNull()
  })

  it("still opens the link when the storage refuses", () => {
    const refusing: QueueStorage = {
      getItem: () => {
        throw new Error("denied")
      },
      setItem: () => {
        throw new Error("denied")
      },
      removeItem: () => undefined,
    }
    expect(resolveFieldToken(`#${A}`, refusing)).toBe(A)
    expect(resolveFieldToken("", refusing)).toBeNull()
    expect(resolveFieldToken(`#${A}`, null)).toBe(A)
  })
})

describe("forgetFieldToken", () => {
  it("forgets the token of a link that is over", () => {
    const storage = memoryStorage({ [FIELD_LINK_KEY]: A })
    forgetFieldToken(A, storage)
    expect(storage.data.has(FIELD_LINK_KEY)).toBe(false)
  })

  it("keeps a newer link opened meanwhile", () => {
    const storage = memoryStorage({ [FIELD_LINK_KEY]: B })
    forgetFieldToken(A, storage)
    expect(storage.data.get(FIELD_LINK_KEY)).toBe(B)
  })
})
