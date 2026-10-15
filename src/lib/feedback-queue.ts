// Local queue of field feedback (KTD10): every feedback entered on the phone is stored here, sent at once, resent
// when the network returns, and removed as soon as the server acknowledges it. Only the entered feedback is kept
// (it may carry a name read on a mailbox), never an API response. A correction or a removal of a feedback goes
// through the same queue, after the feedback itself, so the server always receives them in order, even offline;
// while the feedback is still waiting, the change is applied to it instead.
//
// One storage key per link (feedbackQueueKey): a page only loads and sends the feedback of its own link, so the
// entries of another loop on the same phone are never sent with the wrong token. Several tabs on the same link
// share the key; each save re-reads the storage and merges by entry id, so a tab never erases another's entries.
// Entries left under the former shared key (bare FEEDBACK_QUEUE_KEY, test links only) are neither read nor
// removed: their link is unknown, so moving them to a link could send them with the wrong token.

export const FEEDBACK_QUEUE_KEY = "toctoc-feedback-queue"

/** Storage key of the queue of one link: the prefix and the first 16 hex chars of SHA-256(token), never the token. */
export async function feedbackQueueKey(token: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token))
  const hex = Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("")
  return `${FEEDBACK_QUEUE_KEY}:${hex.slice(0, 16)}`
}


/** Body of POST /api/terrain/retours (R18 fields, dwelling, client id). */
export interface FeedbackEntry {
  /** Generated on the phone, so a resend never duplicates on the server. */
  id: string
  addressId: string
  dwelling: string | null
  /**
   * Dwelling of the building (15/10/2026): a known unit, or a new one added on the phone with its label. Optional:
   * feedback queued by an earlier version has none.
   */
  dwellingUnitId?: string | null
  dwellingUnitLabel?: string | null
  /** The household met is not on the electoral list. */
  nonRegistered?: boolean
  contact: "obtenu" | "absent" | null
  contactQuality: "chaleureux" | "poli" | "ferme" | null
  toAccompany: boolean
  toRevisit: boolean
  qualification: "non_habitation" | "logement_vide" | "residence_secondaire" | null
  qualificationScope: "logement" | "immeuble" | null
  remarks: string | null
  /** Paris calendar date at entry time, so a feedback sent the next morning keeps the day of the visit. */
  visitDate: string
}

/**
 * "refused": the server will never take it (link over); it is to be copied on the paper sheet. Without `op`, the
 * item creates the feedback (the format queued before corrections existed); a correction carries the whole
 * corrected feedback, a removal the feedback removed.
 */
export interface QueueItem {
  entry: FeedbackEntry
  status: "pending" | "refused"
  op?: "update" | "delete"
  /** Own id of a correction or removal item, since several may follow one feedback. */
  qid?: string
}

/** Throws when the change could not reach the server (to retry later). */
export type SendFeedback = (item: QueueItem) => Promise<"acknowledged" | "refused">

export type QueueStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">

export interface FeedbackQueue {
  /** Stores the feedback then tries to send everything pending. */
  add(entry: FeedbackEntry): Promise<void>
  /** Sends the pending feedback, one at a time; concurrent calls share the same run. */
  flush(): Promise<void>
  /** Current entries; the same array until something changes (fit for useSyncExternalStore). */
  items(): QueueItem[]
  /** Called after every change; returns the unsubscribe function. */
  subscribe(listener: () => void): () => void
  /** Queues the corrected version of a feedback entered on this phone (same id). */
  correct(entry: FeedbackEntry): Promise<void>
  /** Queues the removal of a feedback entered on this phone; nothing is sent if it never left the phone. */
  remove(entry: FeedbackEntry): Promise<void>
  /** Forgets a refused item once it has been copied on the sheet (by its itemKey: the feedback id for a creation). */
  dismiss(id: string): void
}

/** Identity of a queue item: the feedback id for its creation, its own id for a correction or a removal. */
export function itemKey(item: QueueItem): string {
  return item.qid ?? item.entry.id
}

function isItem(value: unknown): value is QueueItem {
  if (typeof value !== "object" || value === null) return false
  const v = value as { entry?: { id?: unknown; addressId?: unknown; visitDate?: unknown }; status?: unknown; op?: unknown; qid?: unknown }
  const op = v.op === undefined || ((v.op === "update" || v.op === "delete") && typeof v.qid === "string")
  return (
    op &&
    (v.status === "pending" || v.status === "refused") &&
    typeof v.entry?.id === "string" &&
    typeof v.entry.addressId === "string" &&
    typeof v.entry.visitDate === "string"
  )
}

export function createFeedbackQueue(options: {
  storage: QueueStorage | null
  /** From feedbackQueueKey(token): one queue per link. */
  storageKey: string
  send: SendFeedback
}): FeedbackQueue {
  const { storage, storageKey, send } = options
  const listeners = new Set<() => void>()
  // Ids this page acknowledged or dismissed: a merge never revives them from a copy another tab still holds.
  const removed = new Set<string>()

  function load(): QueueItem[] {
    try {
      const raw = storage?.getItem(storageKey)
      if (!raw) return []
      const parsed: unknown = JSON.parse(raw)
      return Array.isArray(parsed) ? parsed.filter(isItem) : []
    } catch {
      return []
    }
  }

  // Memory is the reference while the page lives; storage only survives a reload or a closed tab.
  let items = load()
  let running: Promise<void> | null = null
  // Item being sent right now: it is never rewritten nor dropped under the request's feet.
  let sending: string | null = null

  function save(): void {
    // Another tab on the same link may have stored entries since: keep them (this page's version wins on an id).
    const known = new Set(items.map(itemKey))
    const others = load().filter((i) => !known.has(itemKey(i)) && !removed.has(itemKey(i)))
    if (others.length > 0) items = [...items, ...others]
    try {
      storage?.setItem(storageKey, JSON.stringify(items))
    } catch {
      // Storage full or blocked: the queue still works in memory for this page.
    }
    for (const listener of listeners) listener()
  }

  async function run(): Promise<void> {
    for (;;) {
      const next = items.find((i) => i.status === "pending")
      if (!next) return
      const key = itemKey(next)
      let outcome: "acknowledged" | "refused"
      sending = key
      try {
        outcome = await send(next)
      } catch {
        return // Network down or server error: keep everything, the next flush retries.
      } finally {
        sending = null
      }
      if (outcome === "acknowledged") removed.add(key)
      items =
        outcome === "acknowledged"
          ? items.filter((i) => itemKey(i) !== key)
          : items.map((i) => (itemKey(i) === key ? { ...i, status: "refused" } : i))
      save()
    }
  }

  function flush(): Promise<void> {
    running ??= run().finally(() => {
      running = null
    })
    return running
  }

  /** Pending items of a feedback that can still be changed (not being sent). */
  const waiting = (id: string) => items.filter((i) => i.entry.id === id && i.status === "pending" && itemKey(i) !== sending)

  async function flushTwice(): Promise<void> {
    await flush()
    await flush()
  }

  return {
    async correct(entry) {
      // Still on the phone: the creation (or the last correction) waiting to leave takes the new version.
      const target = waiting(entry.id).findLast((i) => i.op !== "delete")
      items = target
        ? items.map((i) => (i === target ? { ...i, entry } : i))
        : [...items, { entry, status: "pending", op: "update", qid: crypto.randomUUID() }]
      save()
      await flushTwice()
    },
    async remove(entry) {
      const stale = waiting(entry.id)
      for (const i of stale) removed.add(itemKey(i))
      items = items.filter((i) => !stale.includes(i))
      // Sent already (or being sent): the server needs the removal too.
      const left = items.some((i) => i.entry.id === entry.id && i.op === undefined) || !stale.some((i) => i.op === undefined)
      if (left) items = [...items, { entry, status: "pending", op: "delete", qid: crypto.randomUUID() }]
      save()
      await flushTwice()
    },
    async add(entry) {
      if (!items.some((i) => i.entry.id === entry.id)) {
        items = [...items, { entry, status: "pending" }]
        save()
      }
      // A flush already running may have passed this entry by: run once more after it.
      await flushTwice()
    },
    flush,
    items: () => items,
    subscribe(listener) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    dismiss(id) {
      const gone = items.filter((i) => itemKey(i) === id && i.status === "refused")
      for (const i of gone) removed.add(itemKey(i))
      items = items.filter((i) => !gone.includes(i))
      save()
    },
  }
}
