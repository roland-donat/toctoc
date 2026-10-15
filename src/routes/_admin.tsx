import { createFileRoute, Link, Outlet, redirect, useRouterState } from "@tanstack/react-router"
import { LogOut } from "lucide-react"
import { LaitFraise, Wordmark } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { ApiError, fetchMe, LOGIN_PATH, logout } from "@/lib/api-client"
import { cn } from "@/lib/utils"

export const Route = createFileRoute("/_admin")({
  beforeLoad: async ({ location }) => {
    try {
      await fetchMe()
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        throw redirect({ to: "/login", search: { redirect: location.href } })
      }
      throw err
    }
  },
  component: AdminLayout,
})

const NAV_ITEMS = [
  { href: "/carte", label: "Carte" },
  { href: "/stats", label: "Statistiques" },
  { href: "/itineraires", label: "Itinéraires" },
  { href: "/suivi", label: "Suivi" },
  { href: "/antiseches", label: "Antisèches" },
  { href: "/imports", label: "Imports" },
  { href: "/parametres", label: "Paramètres" },
] as const

function AdminLayout() {
  const { queryClient } = Route.useRouteContext()
  const pathname = useRouterState({ select: (state) => state.location.pathname })

  async function onLogout() {
    try {
      await logout()
    } finally {
      // Drop every cached admin response, then reload on the login page.
      queryClient.clear()
      window.location.assign(LOGIN_PATH)
    }
  }

  return (
    <div className="flex min-h-screen flex-col">
      <header className="bg-primary text-primary-foreground [--tortue-hole:var(--color-primary)]">
        <nav aria-label="Navigation principale" className="mx-auto flex w-full max-w-6xl flex-wrap items-center gap-x-1 gap-y-2 px-4 py-3">
          <Link to="/" className="mr-4 rounded-md focus-visible:ring-2 focus-visible:ring-brand-jaune focus-visible:outline-none">
            <Wordmark />
          </Link>
          {NAV_ITEMS.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`)
            return (
              <a
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full px-3 py-1 text-sm font-semibold transition-colors",
                  active ? "bg-primary-foreground text-primary" : "text-primary-foreground/80 hover:bg-white/10 hover:text-primary-foreground",
                )}
              >
                {item.label}
              </a>
            )
          })}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto gap-2 text-primary-foreground hover:bg-white/10 hover:text-primary-foreground"
            onClick={onLogout}
          >
            <LogOut className="h-4 w-4" />
            Se déconnecter
          </Button>
        </nav>
        <div aria-hidden="true" className="h-1 bg-brand-rouge" />
      </header>
      <div className="flex-1">
        <Outlet />
      </div>
      <footer className="print:hidden mx-auto flex w-full max-w-6xl items-center gap-2 px-4 py-6 font-serif text-sm text-muted-foreground">
        <LaitFraise className="h-5 w-auto" />
        Fait à pas de tortue sagace. Une porte après l'autre.
      </footer>
    </div>
  )
}
