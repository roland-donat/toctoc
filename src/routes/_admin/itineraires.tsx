import { createFileRoute, redirect } from "@tanstack/react-router"

// Former address of the Sessions TocToc list (renamed on 15/10/2026), kept for bookmarks.
export const Route = createFileRoute("/_admin/itineraires")({
  beforeLoad: () => {
    throw redirect({ to: "/sessions", replace: true })
  },
})
