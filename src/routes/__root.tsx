import type { QueryClient } from "@tanstack/react-query"
import { createRootRouteWithContext, Link, Outlet, type ErrorComponentProps } from "@tanstack/react-router"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { LaitFraise, Tortue } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Toaster } from "@/components/ui/sonner"

export interface RouterContext {
  queryClient: QueryClient
}

export const Route = createRootRouteWithContext<RouterContext>()({
  component: RootLayout,
  errorComponent: RootError,
  notFoundComponent: NotFound,
})

function RootError({ error }: ErrorComponentProps) {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <AlertTriangle className="h-12 w-12 text-destructive" />
      <h1 className="page-title text-2xl after:mx-auto">Une erreur est survenue</h1>
      <p className="max-w-md text-sm text-muted-foreground">
        L'application a rencontré un problème. Les données sont conservées sur le serveur.
      </p>
      <p className="flex items-center gap-2 font-serif text-sm">
        <LaitFraise className="h-5 w-auto" />
        Le temps d'un lait fraise, et on recharge.
      </p>
      <p className="max-w-md text-xs text-muted-foreground">{error instanceof Error ? error.name : "Erreur inconnue"}</p>
      <Button onClick={() => window.location.reload()} className="gap-2">
        <RefreshCw className="h-4 w-4" />
        Recharger la page
      </Button>
    </div>
  )
}

function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-4 px-4 text-center">
      <Tortue className="h-16 w-auto text-primary" />
      <h1 className="page-title text-2xl after:mx-auto">Page introuvable</h1>
      <p className="font-serif text-base">Même la tortue sagace s'est égarée en chemin.</p>
      <Link to="/" className="text-sm font-semibold text-primary underline underline-offset-4">
        Retour à l'accueil
      </Link>
    </div>
  )
}

function RootLayout() {
  return (
    <div className="min-h-screen bg-background">
      <Outlet />
      <Toaster position="bottom-center" />
    </div>
  )
}
