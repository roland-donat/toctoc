import { useState } from "react"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { createFileRoute } from "@tanstack/react-router"
import { Plus, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { useDebouncedSave } from "@/hooks/use-debounced-save"
import {
  CHEATSHEET_BANDS,
  cheatsheetsKey,
  createCheatsheet,
  deleteCheatsheet,
  listCheatsheets,
  updateCheatsheet,
  type Cheatsheet,
  type CheatsheetBand,
} from "@/lib/cheatsheets-api"

export const Route = createFileRoute("/_admin/antiseches")({
  component: AntisechesPage,
})

const SAVE_DELAY_MS = 600

function AntisechesPage() {
  const queryClient = useQueryClient()
  const sheets = useQuery({ queryKey: cheatsheetsKey, queryFn: listCheatsheets })
  const refresh = () => queryClient.invalidateQueries({ queryKey: cheatsheetsKey })

  const create = useMutation({
    mutationFn: (ageBand: CheatsheetBand) => createCheatsheet({ ageBand, title: "Nouvelle antisèche", body: "" }),
    onSuccess: refresh,
  })

  return (
    <main className="mx-auto max-w-3xl space-y-8 px-4 py-8">
      <header>
        <h1 className="page-title">Antisèches</h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Arguments affichés à chaque porte selon la tranche d'âge des inscrits. Texte simple, enregistrement automatique.
        </p>
      </header>
      {sheets.isError && <p className="text-sm text-destructive">Impossible de charger les antisèches.</p>}
      {CHEATSHEET_BANDS.map(({ band, label }) => (
        <section key={band} aria-labelledby={`band-${band}`} className="space-y-3">
          <div className="flex items-center justify-between gap-2">
            <h2 id={`band-${band}`} className="text-lg font-extrabold">
              {label}
            </h2>
            <Button size="sm" variant="outline" disabled={create.isPending} onClick={() => create.mutate(band)}>
              <Plus />
              Ajouter une antisèche
            </Button>
          </div>
          {(sheets.data ?? [])
            .filter((s) => s.ageBand === band)
            .map((s) => (
              <SheetEditor key={s.id} sheet={s} onDeleted={refresh} />
            ))}
        </section>
      ))}
    </main>
  )
}

function SheetEditor({ sheet, onDeleted }: { sheet: Cheatsheet; onDeleted: () => void }) {
  const [title, setTitle] = useState(sheet.title)
  const [body, setBody] = useState(sheet.body)
  const [confirming, setConfirming] = useState(false)
  const autosave = useDebouncedSave((patch: { title: string; body: string }) => updateCheatsheet(sheet.id, patch), SAVE_DELAY_MS)

  const remove = useMutation({
    mutationFn: () => deleteCheatsheet(sheet.id),
    onSuccess: onDeleted,
  })

  return (
    <div className="space-y-2 rounded-lg border p-3" data-testid="cheatsheet">
      <div className="flex items-center gap-2">
        <Input
          aria-label="Titre de l'antisèche"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
            autosave.schedule({ title: e.target.value, body })
          }}
        />
        <Button size="icon" variant="ghost" aria-label="Supprimer l'antisèche" onClick={() => setConfirming(true)}>
          <Trash2 />
        </Button>
      </div>
      <textarea
        aria-label="Texte de l'antisèche"
        rows={5}
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          autosave.schedule({ title, body: e.target.value })
        }}
        className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50"
      />
      <div className="min-h-4 text-xs text-muted-foreground" aria-live="polite">
        {autosave.state === "error" ? (
          <span className="text-destructive">Échec de l'enregistrement</span>
        ) : autosave.state === "saved" ? (
          "Enregistré"
        ) : (
          ""
        )}
      </div>
      {/* Plain text preview: React escapes the content, line breaks are kept by CSS. */}
      {body && (
        <p className="rounded-md bg-muted/50 p-2 text-sm" style={{ whiteSpace: "pre-line" }} data-testid="cheatsheet-preview">
          {body}
        </p>
      )}
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Supprimer cette antisèche ?</DialogTitle>
            <DialogDescription>Cette action est définitive.</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Annuler
            </Button>
            <Button variant="destructive" disabled={remove.isPending} onClick={() => {
                // A card being deleted has nothing left to save.
                autosave.cancel()
                remove.mutate()
              }}>
              Supprimer
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
