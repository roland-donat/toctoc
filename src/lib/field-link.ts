import type { QueueStorage } from "@/lib/feedback-queue"
import { tokenFromHash } from "@/lib/terrain-api"

// The field page installed on the home screen opens on /terrain, without the fragment of the link. The token of
// the round in progress is remembered on the phone so the installed app finds it again; it is forgotten as soon
// as the server says the link is over. The exposure is the one of the browser history, which keeps the whole link.
// Nothing returned by the API is kept (KTD10).
export const FIELD_LINK_KEY = "toctoc.terrain.lien"

/** The token of the round: the one of the link just opened, which replaces any remembered one, else the remembered one. */
export function resolveFieldToken(hash: string, storage: QueueStorage | null): string | null {
  const opened = tokenFromHash(hash)
  try {
    if (opened) {
      storage?.setItem(FIELD_LINK_KEY, opened)
      return opened
    }
    const remembered = storage?.getItem(FIELD_LINK_KEY) ?? null
    return remembered !== null && tokenFromHash(remembered) === remembered ? remembered : null
  } catch {
    // Storage refused (private mode, quota): the link still works for this page.
    return opened
  }
}

/** Forgets the remembered token once its link is over, unless another link has replaced it meanwhile. */
export function forgetFieldToken(token: string, storage: QueueStorage | null): void {
  try {
    if (storage?.getItem(FIELD_LINK_KEY) === token) storage.removeItem(FIELD_LINK_KEY)
  } catch {
    // Nothing to forget without storage.
  }
}
