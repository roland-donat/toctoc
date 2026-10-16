import { createFileRoute, redirect } from "@tanstack/react-router"

// Former address of a session page (renamed on 15/10/2026), kept for bookmarks.
export const Route = createFileRoute("/_admin/itineraires_/$id")({
  beforeLoad: ({ params }) => {
    throw redirect({ to: "/sessions/$id", params: { id: params.id }, replace: true })
  },
})
