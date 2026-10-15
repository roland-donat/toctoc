// Data loading behind the Statistics tab and the purge snapshot: one computation for both (U8, KTD16).
import { eq } from "drizzle-orm"
import { z } from "zod"
import type { AppContext } from "../context.ts"
import type { Db } from "../db/index.ts"
import { addresses, electors, registrations, visits, voteHistory } from "../db/schema/index.ts"
import { getSetting, setSetting } from "../db/settings.ts"
import { ageAt, ageBand } from "../domain/age.ts"
import { birthPlaceGroup } from "../domain/birth-place.ts"
import { daysBetween, parisDate } from "../domain/qualification.ts"
import {
  AGE_REFERENCE_DATE,
  campaignActivity,
  campaignCoverage,
  type CampaignActivity,
  type CampaignCoverage,
  type ElectorFacts,
  type RoundFact,
} from "../domain/stats.ts"
import { EMARGEMENT_ELECTION, type ListType } from "../domain/voter-level.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { addressLabel, currentRepImportId } from "./current-list.ts"
import { loadCurrentVoterLevels } from "./voter-levels.ts"
import { isoDateSchema } from "./visits.ts"

export const CAMPAIGN_DATES_KEY = "campaign_dates"

export interface CampaignDates {
  /** ISO date from which doors and sessions are counted. */
  startDate: string
  /** ISO date of the registration deadline for the 2027 presidential election. */
  registrationDeadline: string
}

export const DEFAULT_CAMPAIGN_DATES: CampaignDates = { startDate: "2027-01-01", registrationDeadline: "2027-03-12" }

const campaignDatesSchema = z.object({ startDate: isoDateSchema, registrationDeadline: isoDateSchema }).strict()

/** Stored campaign dates, or the defaults when nothing valid is stored. */
export function loadCampaignDates(db: Db): CampaignDates {
  const parsed = campaignDatesSchema.safeParse(getSetting<unknown>(db, CAMPAIGN_DATES_KEY, null))
  return parsed.success ? parsed.data : DEFAULT_CAMPAIGN_DATES
}

/** Validates then stores the campaign dates; throws a ZodError on an invalid value. */
export function saveCampaignDates(db: Db, dates: CampaignDates): CampaignDates {
  const valid = campaignDatesSchema.parse(dates)
  setSetting(db, CAMPAIGN_DATES_KEY, valid)
  return valid
}

/** One "à accompagner pour inscription" feedback: no name, the dwelling text only. */
export interface AccompanyItem {
  visitId: string
  addressId: string
  addressLabel: string
  visitDate: string
  dwelling: string | null
  done: boolean
}

export interface CampaignReport extends CampaignDates {
  /** Whole days from today (Paris) to the deadline; negative once it has passed. */
  daysToDeadline: number
  activity: CampaignActivity
  coverage: CampaignCoverage
  accompany: { todo: AccompanyItem[]; done: AccompanyItem[] }
}

const LIST_PRIORITY: readonly ListType[] = ["principale", "complementaire_ue", "complementaire_municipale"]

/** Facts of every elector of the current list, from the registration on the principal list when there is one. */
export function loadElectorFacts(db: Db): ElectorFacts[] {
  const importId = currentRepImportId(db)
  if (importId === null) return []
  const levels = loadCurrentVoterLevels(db)
  const regs = db
    .select({
      electorId: registrations.electorId,
      listType: registrations.listType,
      bureau: registrations.bureau,
      addressId: registrations.addressId,
      streetKey: addresses.streetKey,
      streetName: addresses.streetName,
      sex: electors.sex,
      birthDate: electors.birthDate,
      birthCommuneCode: electors.birthCommuneCode,
      birthDepartment: electors.birthDepartment,
      birthCountry: electors.birthCountry,
    })
    .from(registrations)
    .innerJoin(electors, eq(electors.id, registrations.electorId))
    .leftJoin(addresses, eq(addresses.id, registrations.addressId))
    .where(eq(registrations.importId, importId))
    .all()

  const rounds = new Map<string, { t1: RoundFact | null; t2: RoundFact | null }>()
  const history = db
    .select({ electorId: voteHistory.electorId, round: voteHistory.round, value: voteHistory.value, proxy: voteHistory.proxy })
    .from(voteHistory)
    .where(eq(voteHistory.election, EMARGEMENT_ELECTION))
    .all()
  for (const h of history) {
    const entry = rounds.get(h.electorId) ?? { t1: null, t2: null }
    const fact: RoundFact = { value: h.value, proxy: h.proxy?.trim().toLowerCase() === "oui" }
    if (h.round === 1) entry.t1 = fact
    else if (h.round === 2) entry.t2 = fact
    rounds.set(h.electorId, entry)
  }

  const chosen = new Map<string, (typeof regs)[number]>()
  for (const r of regs) {
    const prev = chosen.get(r.electorId)
    if (!prev || LIST_PRIORITY.indexOf(r.listType) < LIST_PRIORITY.indexOf(prev.listType)) chosen.set(r.electorId, r)
  }

  return [...chosen.values()].map((r) => {
    const history = rounds.get(r.electorId)
    const attached = r.addressId !== null && r.streetKey !== null
    return {
      level: levels.get(r.electorId) ?? "inconnu",
      sex: r.sex,
      ageBand: ageBand(ageAt(r.birthDate, AGE_REFERENCE_DATE)),
      bureau: r.bureau,
      streetKey: attached ? r.streetKey : null,
      streetName: attached ? r.streetName : null,
      birthPlace: birthPlaceGroup(r),
      t1: history?.t1 ?? null,
      t2: history?.t2 ?? null,
    }
  })
}

export function accompanyItems(db: Db): AccompanyItem[] {
  return db
    .select({
      visitId: visits.id,
      addressId: visits.addressId,
      visitDate: visits.visitDate,
      recordedAt: visits.recordedAt,
      dwelling: visits.dwelling,
      done: visits.accompanyDone,
      number: addresses.number,
      rep: addresses.rep,
      streetName: addresses.streetName,
    })
    .from(visits)
    .innerJoin(addresses, eq(addresses.id, visits.addressId))
    .where(eq(visits.toAccompany, true))
    .orderBy(visits.visitDate, visits.recordedAt)
    .all()
    .map((v) => ({
      visitId: v.visitId,
      addressId: v.addressId,
      addressLabel: addressLabel(v),
      visitDate: v.visitDate,
      dwelling: v.dwelling,
      done: v.done,
    }))
}

export function campaignReport(ctx: AppContext): CampaignReport {
  const dates = loadCampaignDates(ctx.db)
  const visitRows = ctx.db
    .select({ addressId: visits.addressId, visitDate: visits.visitDate, qualification: visits.qualification })
    .from(visits)
    .all()
  const items = accompanyItems(ctx.db)
  return {
    ...dates,
    daysToDeadline: daysBetween(parisDate(ctx.now()), dates.registrationDeadline),
    activity: campaignActivity(visitRows, dates.startDate),
    coverage: campaignCoverage(computeAddressStatuses(ctx), dates.startDate),
    accompany: { todo: items.filter((i) => !i.done), done: items.filter((i) => i.done) },
  }
}


