import type { Hono } from "hono"
import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, visits } from "../db/schema/index.ts"
import { computeAddressStatuses } from "../services/address-status.ts"
import { retoursRoutes } from "./retours.ts"

const HOUSE = "56243_0110_00029"
const ID1 = "11111111-1111-4111-8111-111111111111"
const ID2 = "22222222-2222-4222-8222-222222222222"

interface VisitJson {
  id: string
  addressId: string
  visitDate: string
  source: string
  qualification: string | null
}

let ctx: AppContext
let router: Hono

function send(path: string, method: string, body?: unknown) {
  return router.request(path, {
    method,
    headers: { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}

function category(): string | undefined {
  return computeAddressStatuses(ctx, { addressIds: [HOUSE] })[0]?.category
}

beforeEach(() => {
  const t = createTestContext({ now: new Date("2027-03-01T10:00:00Z") })
  ctx = t.ctx
  router = retoursRoutes(ctx)
  ctx.db
    .insert(addresses)
    .values({
      id: HOUSE,
      kind: "number",
      number: 29,
      streetName: "Rue de Limur",
      streetKey: "rue de limur",
      inseeCode: "56243",
      matchKey: "29|rue de limur",
      lat: 47.6,
      lon: -2.7,
      updatedAt: 0,
    })
    .run()
})

describe("POST /api/retours", () => {
  it("records an admin entry dated today and answers 201", async () => {
    const res = await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", contact: "absent" })
    expect(res.status).toBe(201)
    expect((await res.json()) as VisitJson).toMatchObject({ id: ID1, addressId: HOUSE, source: "admin", visitDate: "2027-03-01" })
  })

  it("answers 200 with the stored row when the same id is sent again, without a second row", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "feuille", visitDate: "2027-02-20" })
    const again = await send("/", "POST", { id: ID1, addressId: HOUSE, source: "feuille", visitDate: "2027-02-20" })
    expect(again.status).toBe(200)
    expect(ctx.db.select().from(visits).all()).toHaveLength(1)
  })

  it("requires the visit date for a paper re-entry", async () => {
    expect((await send("/", "POST", { id: ID1, addressId: HOUSE, source: "feuille" })).status).toBe(400)
  })

  it("refuses the field-link source, a cancellation and an opinion field", async () => {
    expect((await send("/", "POST", { id: ID1, addressId: HOUSE, source: "lien" })).status).toBe(400)
    expect((await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", qualification: "annulation" })).status).toBe(400)
    const withOpinion = await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", opinion: "x" })
    expect(withOpinion.status).toBe(400)
  })

  it("answers 404 for an unknown address", async () => {
    expect((await send("/", "POST", { id: ID1, addressId: "nope", source: "admin" })).status).toBe(404)
  })
})

describe("GET /api/retours", () => {
  it("returns the dated history of the address, newest first", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "feuille", visitDate: "2027-01-10" })
    await send("/", "POST", { id: ID2, addressId: HOUSE, source: "feuille", visitDate: "2027-02-10" })
    const res = await send(`/?addressId=${HOUSE}`, "GET")
    expect(res.status).toBe(200)
    expect(((await res.json()) as VisitJson[]).map((v) => v.visitDate)).toEqual(["2027-02-10", "2027-01-10"])
  })

  it("requires the address", async () => {
    expect((await send("/", "GET")).status).toBe(400)
  })
})

describe("POST /api/retours/annulation", () => {
  it("lifts the exclusion of an address qualified résidence secondaire (AE2)", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", qualification: "residence_secondaire" })
    expect(category()).toBe("exclue")
    const res = await send("/annulation", "POST", { addressId: HOUSE })
    expect(res.status).toBe(201)
    expect((await res.json()) as VisitJson).toMatchObject({ qualification: "annulation", source: "admin" })
    expect(category()).toBe("sans_inscrit")
  })

  it("answers 409 when nothing excludes the address", async () => {
    expect((await send("/annulation", "POST", { addressId: HOUSE })).status).toBe(409)
  })
})

describe("PATCH /api/retours/:id", () => {
  it("corrects only the fields sent, dates the correction and keeps the visit date", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "feuille", visitDate: "2027-02-20", contact: "absent", remarks: "boîte B" })
    ctx.now = () => new Date("2027-03-02T09:00:00Z")
    const res = await send(`/${ID1}`, "PATCH", { contact: "obtenu", contactQuality: "poli", toRevisit: true })
    expect(res.status).toBe(200)
    const row = ctx.db.select().from(visits).all()[0]
    expect(row).toMatchObject({ contact: "obtenu", contactQuality: "poli", toRevisit: true, remarks: "boîte B", visitDate: "2027-02-20" })
    expect(row?.correctedAt).toBe(new Date("2027-03-02T09:00:00Z").getTime())
  })

  it("drops a quality without contact and a scope without qualification, and clears an emptied text", async () => {
    await send("/", "POST", {
      id: ID1,
      addressId: HOUSE,
      source: "admin",
      contact: "obtenu",
      contactQuality: "chaleureux",
      qualification: "logement_vide",
      qualificationScope: "logement",
      remarks: "x",
    })
    await send(`/${ID1}`, "PATCH", { contact: "absent", qualification: null, remarks: "  " })
    expect(ctx.db.select().from(visits).all()[0]).toMatchObject({
      contact: "absent",
      contactQuality: null,
      qualification: null,
      qualificationScope: null,
      remarks: null,
    })
  })

  it("refuses a feedback left without contact nor qualification, a cancellation row and an unknown id", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", contact: "absent" })
    expect((await send(`/${ID1}`, "PATCH", { contact: null })).status).toBe(422)
    await send("/", "POST", { id: ID2, addressId: HOUSE, source: "admin", qualification: "residence_secondaire" })
    const cancel = (await (await send("/annulation", "POST", { addressId: HOUSE })).json()) as VisitJson
    expect((await send(`/${cancel.id}`, "PATCH", { toRevisit: true })).status).toBe(409)
    expect((await send("/33333333-3333-4333-8333-333333333333", "PATCH", { toRevisit: true })).status).toBe(404)
    expect((await send(`/${ID1}`, "PATCH", { visitDate: "2027-01-01" })).status).toBe(400)
  })

  it("masks the free texts of the answer in anonymous mode", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", contact: "absent", dwelling: "Apt 3" })
    const body = (await (await send(`/${ID1}`, "PATCH", { toRevisit: true })).json()) as { dwelling: string | null }
    expect(body.dwelling).toBeNull()
    expect(ctx.db.select().from(visits).all()[0]?.dwelling).toBe("Apt 3")
  })
})

describe("DELETE /api/retours/:id", () => {
  it("removes a feedback entered by mistake, so the door is back to its earlier state", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", qualification: "residence_secondaire" })
    expect(category()).toBe("exclue")
    expect((await send(`/${ID1}`, "DELETE")).status).toBe(200)
    expect(ctx.db.select().from(visits).all()).toHaveLength(0)
    expect(category()).toBe("sans_inscrit")
    expect(computeAddressStatuses(ctx, { addressIds: [HOUSE] })[0]?.followUp).toBe("jamais_visitee")
  })

  it("keeps a cancellation row and answers 404 for an unknown id", async () => {
    await send("/", "POST", { id: ID1, addressId: HOUSE, source: "admin", qualification: "residence_secondaire" })
    const cancel = (await (await send("/annulation", "POST", { addressId: HOUSE })).json()) as VisitJson
    expect((await send(`/${cancel.id}`, "DELETE")).status).toBe(409)
    expect((await send(`/${ID2}`, "DELETE")).status).toBe(404)
  })
})
