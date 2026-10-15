import { beforeEach, describe, expect, it } from "vitest"
import { createTestContext } from "../../tests/helpers.ts"
import type { AppContext } from "../context.ts"
import { addresses, commerces } from "../db/schema/index.ts"
import { matchKey } from "../domain/address-normalize.ts"
import { adressesRoutes } from "../routes/adresses.ts"
import { importRoutes } from "../routes/imports.ts"
import { computeAddressStatuses } from "./address-status.ts"
import { commercesStatus, loadCommerces, parseCommerces, type CommercePoi } from "./commerces-loader.ts"

// Two fictional doors 100 m apart on a public street; no elector anywhere, so both start "sans inscrit".
const SHOP = "56243_0110_00004"
const HOUSE = "56243_0110_00008"
let ctx: AppContext

beforeEach(() => {
  ctx = createTestContext().ctx
  for (const [id, number, lat] of [
    [SHOP, 4, 47.6],
    [HOUSE, 8, 47.6009],
  ] as const) {
    ctx.db
      .insert(addresses)
      .values({
        id,
        kind: "number",
        number,
        streetName: "Rue de Limur",
        streetKey: "rue de limur",
        inseeCode: "56243",
        matchKey: matchKey(number, null, "Rue de Limur"),
        lat,
        lon: -2.7,
        updatedAt: 0,
      })
      .run()
  }
})

const category = (id: string) => computeAddressStatuses(ctx, { addressIds: [id] })[0]?.category

describe("loadCommerces", () => {
  it("attaches a shop front by its OpenStreetMap number and street, else to the nearest door within 20 m", () => {
    const pois: CommercePoi[] = [
      { id: "n1", kind: "shop=bakery", lat: 47.6004, lon: -2.7, housenumber: "4", street: "rue de Limur" },
      { id: "w2", kind: "amenity=pharmacy", lat: 47.60092, lon: -2.70001 },
      { id: "n3", kind: "shop=florist", lat: 47.61, lon: -2.7 },
    ]
    expect(loadCommerces(ctx, pois)).toEqual({ total: 3, attached: 2 })
    const rows = ctx.db.select().from(commerces).all()
    expect(Object.fromEntries(rows.map((r) => [r.id, r.addressId]))).toEqual({ n1: SHOP, w2: HOUSE, n3: null })
    expect(commercesStatus(ctx)).toMatchObject({ total: 3, attached: 2 })
  })

  it("turns a door with no voter into a commerce probable, which the administrator can give back", async () => {
    loadCommerces(ctx, [{ id: "n1", kind: "shop=bakery", lat: 47.6, lon: -2.7 }])
    expect(category(SHOP)).toBe("commerce_probable")
    expect(category(HOUSE)).toBe("sans_inscrit")

    const app = adressesRoutes(ctx)
    const sheet = (await (await app.request(`/${SHOP}`)).json()) as { commerce: unknown }
    expect(sheet.commerce).toEqual({ kinds: ["shop=bakery"], dismissed: false })
    const res = await app.request(`/${SHOP}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commerceDismissed: true }),
    })
    expect(res.status).toBe(200)
    expect(category(SHOP)).toBe("sans_inscrit")
  })

  it("replaces the previous load, and a reload keeps a door given back", () => {
    loadCommerces(ctx, [{ id: "n1", kind: "shop=bakery", lat: 47.6, lon: -2.7 }])
    loadCommerces(ctx, [{ id: "n9", kind: "office=insurance", lat: 47.6009, lon: -2.7 }])
    expect(category(SHOP)).toBe("sans_inscrit")
    expect(category(HOUSE)).toBe("commerce_probable")
  })
})

describe("commerces file", () => {
  it("refuses a file that is not the extracted list", () => {
    expect(() => parseCommerces("not json")).toThrowError(/not JSON/)
    expect(() => parseCommerces(JSON.stringify([{ id: "x", kind: "shop" }]))).toThrowError(/expected shape/)
  })

  it("loads an uploaded file and reports the missing server file", async () => {
    const app = importRoutes(ctx)
    expect((await app.request("/commerces/load", { method: "POST" })).status).toBe(404)
    const form = new FormData()
    form.append("file", new File([JSON.stringify([{ id: "n1", kind: "shop=bakery", lat: 47.6, lon: -2.7 }])], "c.json"))
    const res = await app.request("/commerces", { method: "POST", body: form })
    expect(await res.json()).toEqual({ total: 1, attached: 1 })
    const bad = new FormData()
    bad.append("file", new File(["[1]"], "c.json"))
    expect((await app.request("/commerces", { method: "POST", body: bad })).status).toBe(400)
  })
})
