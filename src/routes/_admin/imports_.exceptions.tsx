import { createFileRoute, Link } from "@tanstack/react-router"
import { ArrowLeft } from "lucide-react"
import { ImportExceptions } from "@/components/import-exceptions"

// Not nested under /imports (the trailing underscore): the Imports screen has no outlet.
export const Route = createFileRoute("/_admin/imports_/exceptions")({
  component: ExceptionsPage,
})

function ExceptionsPage() {
  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header className="space-y-2">
        <Link to="/imports" className="inline-flex items-center gap-1 text-sm text-muted-foreground hover:text-foreground">
          <ArrowLeft className="h-4 w-4" />
          Imports
        </Link>
        <h1 className="page-title">Exceptions</h1>
        <p className="text-sm text-muted-foreground">
          Lignes et inscriptions que les imports n'ont pas pu traiter seuls. Chaque correction est enregistrée aussitôt.
        </p>
      </header>
      <ImportExceptions />
    </main>
  )
}
