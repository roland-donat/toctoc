import { useState, type FormEvent } from "react"
import { createFileRoute, useNavigate } from "@tanstack/react-router"
import { LaitFraise, Tortue } from "@/components/brand"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { ApiError, login } from "@/lib/api-client"

/** Only same-site paths are followed after login, never an absolute or protocol-relative URL. */
function safeRedirect(target: unknown): string {
  return typeof target === "string" && target.startsWith("/") && !target.startsWith("//") ? target : "/"
}

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } =>
    typeof search.redirect === "string" ? { redirect: search.redirect } : {},
  component: LoginPage,
})

function errorMessage(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.status === 401) return "Mot de passe incorrect."
    if (err.status === 429) return "Trop de tentatives. Patientez quelques secondes avant de réessayer."
  }
  return "Connexion impossible pour le moment. Réessayez."
}

function LoginPage() {
  const navigate = useNavigate()
  const { redirect } = Route.useSearch()
  const [password, setPassword] = useState("")
  const [error, setError] = useState<string | null>(null)
  const [pending, setPending] = useState(false)

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPending(true)
    setError(null)
    try {
      await login(password)
      setPassword("")
      await navigate({ href: safeRedirect(redirect) })
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col justify-center px-4">
      <div className="flex items-end gap-1 text-primary">
        <Tortue className="h-14 w-auto" />
        <LaitFraise className="mb-1 h-9 w-auto" />
      </div>
      <h1 className="page-title mt-4 text-5xl">TOCTOC</h1>
      <p className="mt-3 font-serif text-lg leading-snug text-balance">Lentement mais sûrement, porte après porte.</p>
      <p className="mt-1 text-sm text-muted-foreground">Espace de préparation, réservé à l'administrateur.</p>
      <form onSubmit={onSubmit} className="mt-8 flex flex-col gap-3 rounded-xl border bg-card p-5 shadow-sm">
        <Label htmlFor="password">Mot de passe</Label>
        <Input
          id="password"
          type="password"
          autoComplete="current-password"
          autoFocus
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          aria-invalid={error !== null}
        />
        {error && (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" disabled={pending || password.length === 0}>
          {pending ? "Connexion…" : "Se connecter"}
        </Button>
      </form>
    </main>
  )
}
