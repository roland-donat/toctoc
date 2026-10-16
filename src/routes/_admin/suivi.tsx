import { createFileRoute, redirect } from "@tanstack/react-router"

// The Suivi tab became part of Sessions TocToc on 15/10/2026: the feedback of a session is on its "Retours" tab.
export const Route = createFileRoute("/_admin/suivi")({
  validateSearch: (search: Record<string, unknown>): { itineraire?: string } =>
    typeof search.itineraire === "string" && search.itineraire !== "" ? { itineraire: search.itineraire } : {},
  beforeLoad: ({ search }) => {
    if (search.itineraire) throw redirect({ to: "/sessions/$id", params: { id: search.itineraire }, search: { onglet: "retours" }, replace: true })
    throw redirect({ to: "/sessions", replace: true })
  },
})
