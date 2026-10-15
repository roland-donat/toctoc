import { beforeAll, describe, expect, it } from "vitest"
import {
  createFeedbackQueue,
  FEEDBACK_QUEUE_KEY,
  feedbackQueueKey,
  type FeedbackEntry,
  type QueueStorage,
} from "./feedback-queue"
import { parisCalendarDate } from "./format"
import { createFeedbackSender } from "./terrain-api"

const TOKEN = "fictional-token-for-the-queue-test-0000000"
const OTHER_TOKEN = "fictional-token-of-another-link-11111111"
let KEY = ""
let OTHER_KEY = ""

beforeAll(async () => {
  KEY = await feedbackQueueKey(TOKEN)
  OTHER_KEY = await feedbackQueueKey(OTHER_TOKEN)
})

function memoryStorage(): QueueStorage & { data: Map<string, string> } {
  const data = new Map<string, string>()
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => {
      data.set(k, v)
    },
    removeItem: (k) => {
      data.delete(k)
    },
  }
}

interface Call {
  url: string
  headers: Record<string, string>
  body: unknown
}

/** Fake server: records every request; `mode` decides the answer. */
function fakeFetch(mode: { current: "up" | "down" | "over" }) {
  const calls: Call[] = []
  const received = new Set<string>()
  const impl = async (input: string, init?: RequestInit): Promise<Response> => {
    if (mode.current === "down") throw new TypeError("Failed to fetch")
    const body = JSON.parse(String(init?.body)) as FeedbackEntry
    calls.push({ url: input, headers: Object.fromEntries(new Headers(init?.headers).entries()), body })
    if (mode.current === "over") return new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
    const created = !received.has(body.id)
    received.add(body.id)
    return new Response(JSON.stringify({ id: body.id, created }), { status: created ? 201 : 200 })
  }
  return { impl, calls }
}

function entry(id: string): FeedbackEntry {
  return {
    id,
    addressId: "addr-1",
    dwelling: "apt 4",
    contact: "absent",
    contactQuality: null,
    toAccompany: false,
    toRevisit: true,
    qualification: null,
    qualificationScope: null,
    remarks: null,
    visitDate: "2027-03-01",
  }
}

const ID1 = "00000000-0000-4000-8000-000000000001"
const ID2 = "00000000-0000-4000-8000-000000000002"

describe("feedback queue", () => {
  it("removes a feedback from the local queue once the server acknowledges it, sending the token in a header only", async () => {
    const storage = memoryStorage()
    const mode = { current: "up" as const }
    const server = fakeFetch(mode)
    const queue = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    expect(server.calls).toHaveLength(1)
    expect(server.calls[0]?.url).toBe("/api/terrain/retours")
    expect(server.calls[0]?.url).not.toContain(TOKEN)
    expect(server.calls[0]?.headers["x-toctoc-token"]).toBe(TOKEN)
    expect(queue.items()).toEqual([])
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual([])
  })

  it("keeps a feedback while the network is down, then sends it exactly once when it returns", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "down" }
    const server = fakeFetch(mode)
    const queue = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    expect(queue.items()).toEqual([{ entry: entry(ID1), status: "pending" }])
    // Only the entered feedback is stored, nothing else.
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual([{ entry: entry(ID1), status: "pending" }])

    await queue.flush()
    expect(queue.items()).toHaveLength(1)

    mode.current = "up"
    // The 'online' event and the periodic retry may fire together.
    await Promise.all([queue.flush(), queue.flush(), queue.flush()])
    expect(server.calls).toHaveLength(1)
    expect(queue.items()).toEqual([])
    await queue.flush()
    expect(server.calls).toHaveLength(1)
  })

  it("picks up the feedback left in storage by a previous page", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "down" }
    const server = fakeFetch(mode)
    await createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) }).add(entry(ID1))
    mode.current = "up"
    const reopened = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    expect(reopened.items()).toHaveLength(1)
    await reopened.flush()
    expect(server.calls).toHaveLength(1)
    expect(reopened.items()).toEqual([])
  })

  it("marks a feedback refused because the link is over, and stops resending it until dismissed", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "over" }
    const server = fakeFetch(mode)
    const queue = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    expect(queue.items()).toEqual([{ entry: entry(ID1), status: "refused" }])
    await queue.flush()
    expect(server.calls).toHaveLength(1)
    queue.dismiss(ID1)
    expect(queue.items()).toEqual([])
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual([])
  })

  it("keys the storage per link with a hash of the token, never the token itself", () => {
    expect(KEY).toMatch(new RegExp(`^${FEEDBACK_QUEUE_KEY}:[0-9a-f]{16}$`))
    expect(KEY).not.toContain(TOKEN)
    expect(OTHER_KEY).not.toBe(KEY)
  })

  it("never loads nor sends the feedback queued by another link on the same phone", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "down" }
    const server = fakeFetch(mode)
    await createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) }).add(entry(ID1))
    mode.current = "up"
    const other = createFeedbackQueue({ storage, storageKey: OTHER_KEY, send: createFeedbackSender(OTHER_TOKEN, server.impl) })
    expect(other.items()).toEqual([])
    await other.flush()
    expect(server.calls).toEqual([])
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual([{ entry: entry(ID1), status: "pending" }])
  })

  it("two tabs on the same link do not erase each other's pending feedback", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "down" }
    const server = fakeFetch(mode)
    const tabA = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    const tabB = createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await tabA.add(entry(ID1))
    await tabB.add(entry(ID2))
    const stored = (JSON.parse(storage.data.get(KEY) ?? "[]") as { entry: FeedbackEntry }[]).map((i) => i.entry.id)
    expect(stored.sort()).toEqual([ID1, ID2])

    // Tab A acknowledges its entry: the other tab's entry stays stored and the acknowledged one is not revived.
    mode.current = "up"
    await tabA.flush()
    await tabB.flush()
    expect(JSON.parse(storage.data.get(KEY) ?? "null")).toEqual([])
    expect(new Set(server.calls.map((c) => (c.body as FeedbackEntry).id))).toEqual(new Set([ID1, ID2]))
  })

  it("sends a queued feedback with the date it was entered, even when flushed on a later day", async () => {
    const storage = memoryStorage()
    const mode: { current: "up" | "down" | "over" } = { current: "down" }
    const server = fakeFetch(mode)
    const enteredAt = new Date("2027-03-01T21:30:00Z") // 22:30 in Paris, still March 1st
    const queued = { ...entry(ID1), visitDate: parisCalendarDate(enteredAt) }
    await createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) }).add(queued)
    mode.current = "up"
    await createFeedbackQueue({ storage, storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) }).flush()
    expect((server.calls[0]?.body as FeedbackEntry).visitDate).toBe("2027-03-01")
    expect(parisCalendarDate(new Date("2027-03-01T23:30:00Z"))).toBe("2027-03-02")
  })
})

describe("corrections and removals in the queue", () => {
  /** Fake server answering every write; records method, url and body. */
  function writes(mode: { current: "up" | "down" }) {
    const calls: { method: string; url: string; body: unknown }[] = []
    const impl = async (url: string, init?: RequestInit): Promise<Response> => {
      if (mode.current === "down") throw new TypeError("Failed to fetch")
      calls.push({ method: init?.method ?? "GET", url, body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) })
      return new Response("{}", { status: 200 })
    }
    return { impl, calls }
  }

  it("folds a correction into a feedback that has not left the phone yet: one creation with the new values", async () => {
    const mode: { current: "up" | "down" } = { current: "down" }
    const server = writes(mode)
    const queue = createFeedbackQueue({ storage: memoryStorage(), storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    await queue.correct({ ...entry(ID1), contact: "obtenu" })
    expect(queue.items()).toHaveLength(1)
    mode.current = "up"
    await queue.flush()
    expect(server.calls).toEqual([{ method: "POST", url: "/api/terrain/retours", body: { ...entry(ID1), contact: "obtenu" } }])
  })

  it("sends nothing at all for a feedback removed before it left the phone", async () => {
    const mode: { current: "up" | "down" } = { current: "down" }
    const server = writes(mode)
    const queue = createFeedbackQueue({ storage: memoryStorage(), storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    await queue.remove(entry(ID1))
    mode.current = "up"
    await queue.flush()
    expect(server.calls).toEqual([])
    expect(queue.items()).toEqual([])
  })

  it("sends a correction then a removal of an acknowledged feedback in order, the removal replacing a waiting correction", async () => {
    const mode: { current: "up" | "down" } = { current: "up" }
    const server = writes(mode)
    const queue = createFeedbackQueue({ storage: memoryStorage(), storageKey: KEY, send: createFeedbackSender(TOKEN, server.impl) })
    await queue.add(entry(ID1))
    await queue.correct({ ...entry(ID1), toRevisit: false, remarks: "rappeler" })
    expect(server.calls[1]).toEqual({
      method: "PATCH",
      url: `/api/terrain/retours/${ID1}`,
      body: {
        dwelling: "apt 4",
        contact: "absent",
        contactQuality: null,
        toAccompany: false,
        toRevisit: false,
        qualification: null,
        qualificationScope: null,
        remarks: "rappeler",
      },
    })
    mode.current = "down"
    await queue.correct({ ...entry(ID1), contact: "obtenu" })
    await queue.remove(entry(ID1))
    expect(queue.items().map((i) => i.op)).toEqual(["delete"])
    mode.current = "up"
    await queue.flush()
    expect(server.calls.map((c) => c.method)).toEqual(["POST", "PATCH", "DELETE"])
    expect(queue.items()).toEqual([])
  })
})
