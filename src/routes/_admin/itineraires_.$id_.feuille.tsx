import { createFileRoute, redirect } from "@tanstack/react-router"

// Former address of the printable sheet (renamed on 15/10/2026), kept for bookmarks.
export const Route = createFileRoute("/_admin/itineraires_/$id_/feuille")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/sessions/$id/feuille", params: { id: params.id }, replace: true })
  },
})
