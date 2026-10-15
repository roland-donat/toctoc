// Abstention level of an elector (R3, KTD13), computed on read from the frozen 2026 voting history.
// Pure: the loader of every level of the current list lives in server/services/voter-levels.ts.
import type { registrations, voteHistory } from "../db/schema/index.ts"

export type ListType = (typeof registrations.$inferSelect)["listType"]
export type VoteValue = (typeof voteHistory.$inferSelect)["value"]

export const LIST_TYPES: readonly ListType[] = ["principale", "complementaire_ue", "complementaire_municipale"]

const VOTE_VALUES: readonly VoteValue[] = ["oui", "non", "illisible"]

/** A stored vote value; anything else reads as unreadable, never as "non" (KTD13). */
export const asVote = (value: unknown): VoteValue => VOTE_VALUES.find((v) => v === value) ?? "illisible"

/** Election code of the frozen history in vote_history. */
export const EMARGEMENT_ELECTION = "municipales-2026"

/**
 * - `fort`: missed both readable rounds; `moyen`: missed one; `votant`: voted at every readable round.
 * - `hors_cible`: only on complementary lists (EU citizens do not vote at the presidential election).
 * - `inconnu`: on the emargement's reference list but no readable applied round (neither target nor counted).
 * - `nouvel_inscrit`: absent from the emargement's reference list (registered after March 2026).
 */
export type VoterLevel = "fort" | "moyen" | "votant" | "hors_cible" | "inconnu" | "nouvel_inscrit"

export const VOTER_LEVELS: readonly VoterLevel[] = ["fort", "moyen", "votant", "hors_cible", "inconnu", "nouvel_inscrit"]

export interface VoterLevelInput {
  /** List types of the elector's registrations on the current list. */
  listTypes: readonly ListType[]
  /** Whether the elector was on the list the emargement was matched against. */
  onReferenceList: boolean
  /** Values of the applied 2026 rounds (one per round present in the history, in any order). */
  rounds: readonly VoteValue[]
}

export function voterLevel({ listTypes, onReferenceList, rounds }: VoterLevelInput): VoterLevel {
  if (listTypes.length > 0 && !listTypes.includes("principale")) return "hors_cible"
  if (!onReferenceList) return "nouvel_inscrit"
  const readable = rounds.filter((v) => v !== "illisible")
  if (readable.length === 0) return "inconnu"
  const missed = readable.filter((v) => v === "non").length
  if (readable.length === 1) return missed === 1 ? "moyen" : "votant"
  if (missed === 0) return "votant"
  return missed === readable.length ? "fort" : "moyen"
}
