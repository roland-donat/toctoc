import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Link } from "@tanstack/react-router"
import { Plus } from "lucide-react"
import { useState } from "react"
import { NewSession } from "@/components/new-session"
import { ArchiveSessionButton, DeleteSessionButton, linkStateShort, SessionHistoryButton, SessionProgress } from "@/components/session-controls"
import { Button } from "@/components/ui/button"
import { parisDateTimeFormat } from "@/lib/format"
import { fetchSessions, formatDuration, sessionsKey, sessionTitle } from "@/lib/itineraires-api"
import { cn } from "@/lib/utils"

// Sessions TocToc (15/10/2026): the door-to-door sessions, active by default, archived ones apart; creation of a new
// one with its itinerary.
export const Route = createFileRoute("/_admin/sessions")({
  validateSearch: (search: Record<string, unknown>): { vue?: "archives" } => (search.vue === "archives" ? { vue: "archives" } : {}),
  component: SessionsPage,
})

function SessionsPage() {
  const { vue } = Route.useSearch()
  const archived = vue === "archives"
  const [creating, setCreating] = useState(false)
  const list = useQuery({ queryKey: sessionsKey(archived), queryFn: () => fetchSessions(archived) })

  return (
    <main className="mx-auto max-w-6xl space-y-6 px-4 py-8">
      <header className="flex flex-wrap items-center gap-3">
        <h1 className="page-title">Sessions TocToc</h1>
        {!creating && !archived && (
          <Button className="ml-auto gap-2" onClick={() => setCreating(true)}>
            <Plus className="h-4 w-4" />
            Nouvelle session
          </Button>
        )}
      </header>

      {creating && <NewSession onCancel={() => setCreating(false)} />}

      <nav aria-label="Sessions" className="flex gap-1 border-b">
        {(
          [
            [false, "Actives"],
            [true, "Archivées"],
          ] as const
        ).map(([a, label]) => (
          <Link
            key={label}
            to="/sessions"
            search={a ? { vue: "archives" } : {}}
            aria-current={archived === a ? "page" : undefined}
            className={cn(
              "-mb-px border-b-2 px-3 py-2 text-sm font-semibold",
              archived === a ? "border-primary text-primary" : "border-transparent text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </Link>
        ))}
      </nav>

      {list.isError && <p className="text-sm text-destructive">Impossible de charger les sessions.</p>}
      {list.data && list.data.itineraries.length === 0 && !creating && (
        <p className="text-sm text-muted-foreground">{archived ? "Aucune session archivée." : "Aucune session en cours."}</p>
      )}
      {list.data && list.data.itineraries.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr className="border-b">
              <th className="py-2 font-medium">Session</th>
              <th className="py-2 font-medium">Progression</th>
              <th className="py-2 pr-4 text-right font-medium">Retours</th>
              <th className="py-2 font-medium">Lien terrain</th>
              <th className="py-2 font-medium">Mise à jour</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {list.data.itineraries.map((s) => (
              <tr key={s.id} className="border-b align-top last:border-0" data-testid="session-row">
                <td className="py-2 pr-2">
                  <Link to="/sessions/$id" params={{ id: s.id }} className="font-semibold underline-offset-4 hover:underline">
                    {sessionTitle(s)}
                  </Link>
                  <span className="block text-xs text-muted-foreground">
                    Créée le {parisDateTimeFormat.format(new Date(s.createdAt))} · {s.zoneLabel} · {formatDuration(s.durationMinutes * 60)}
                  </span>
                </td>
                <td className="py-2 pr-2">
                  <SessionProgress done={s.doorsDone} total={s.doorCount} />
                </td>
                <td className="py-2 pr-4 text-right tabular-nums">{s.feedbackCount}</td>
                <td className="py-2 pr-2 text-xs">{linkStateShort(s.link)}</td>
                <td className="py-2 pr-2 text-xs tabular-nums">{parisDateTimeFormat.format(new Date(s.updatedAt))}</td>
                <td className="py-2">
                  <div className="flex flex-wrap justify-end gap-1">
                    <SessionHistoryButton session={s} />
                    <ArchiveSessionButton session={s} />
                    <DeleteSessionButton session={s} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  )
}
