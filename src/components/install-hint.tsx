import { useEffect, useState } from "react"

// The prompt Chrome raises when it judges the page installable; not in the DOM typings.
interface BeforeInstallPromptEvent extends Event {
  prompt(): Promise<void>
}

const DISMISSED_KEY = "toctoc.terrain.astuce-installation"

function isInstalled(): boolean {
  return window.matchMedia?.("(display-mode: standalone)").matches ?? false
}

function wasDismissed(): boolean {
  try {
    return window.localStorage.getItem(DISMISSED_KEY) === "1"
  } catch {
    return false
  }
}

/**
 * Tells the volunteer the field page can live on the home screen. Chrome offers the install from its menu even
 * without service worker (none here, KTD10); when it raises its own prompt, a button opens it directly.
 */
export function InstallHint() {
  const [hidden, setHidden] = useState(() => isInstalled() || wasDismissed())
  const [prompt, setPrompt] = useState<BeforeInstallPromptEvent | null>(null)

  useEffect(() => {
    const onPrompt = (event: Event) => {
      event.preventDefault()
      setPrompt(event as BeforeInstallPromptEvent)
    }
    const onInstalled = () => setHidden(true)
    window.addEventListener("beforeinstallprompt", onPrompt)
    window.addEventListener("appinstalled", onInstalled)
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt)
      window.removeEventListener("appinstalled", onInstalled)
    }
  }, [])

  if (hidden) return null

  function dismiss() {
    try {
      window.localStorage.setItem(DISMISSED_KEY, "1")
    } catch {
      // Shown again next time, nothing more.
    }
    setHidden(true)
  }

  return (
    <aside aria-label="Installer l'application" className="flex items-start gap-3 rounded-lg border border-lfi-violet/30 bg-white p-3 text-sm">
      <p className="flex-1">
        {prompt ? (
          "Installez TOCTOC sur l'écran d'accueil : il s'ouvrira en plein écran sur votre tournée."
        ) : (
          <>
            Pour retrouver la tournée d'un geste : menu <span aria-hidden="true">⋮</span> du navigateur, puis « Installer
            l'application » ou « Ajouter à l'écran d'accueil ».
          </>
        )}
      </p>
      <div className="flex shrink-0 flex-col gap-1">
        {prompt && (
          <button
            type="button"
            className="min-h-10 rounded-md bg-primary px-3 font-semibold text-primary-foreground"
            onClick={() => void prompt.prompt().then(() => setPrompt(null))}
          >
            Installer
          </button>
        )}
        <button type="button" className="min-h-10 rounded-md px-3 font-semibold text-slate-700" onClick={dismiss}>
          Masquer
        </button>
      </div>
    </aside>
  )
}
