import { createFileRoute, redirect } from "@tanstack/react-router"

// The map is the home screen of the administrator.
export const Route = createFileRoute("/_admin/")({
  beforeLoad: () => {
    throw redirect({ to: "/carte", replace: true })
  },
})
