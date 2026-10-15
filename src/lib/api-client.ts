export class ApiError extends Error {
  override name = "ApiError"
  readonly status: number
  readonly code: string

  constructor(status: number, code: string) {
    super(`API error ${status}: ${code}`)
    this.status = status
    this.code = code
  }
}

export const LOGIN_PATH = "/login"

/**
 * An expired or missing session sends the administrator back to the login page. Not for the auth calls
 * themselves (a wrong password is a 401 the login page shows) nor for the field pages, which never log in.
 */
function redirectToLoginOn401(url: string): void {
  if (typeof window === "undefined") return
  if (url.startsWith("/auth/")) return
  const here = window.location.pathname
  if (here === "/terrain" || here.startsWith("/terrain/") || here === LOGIN_PATH) return
  const back = `${window.location.pathname}${window.location.search}`
  window.location.assign(`${LOGIN_PATH}?redirect=${encodeURIComponent(back)}`)
}

export async function fetchJSON<T>(url: string, init?: RequestInit): Promise<T> {
  const isForm = init?.body instanceof FormData
  const res = await fetch(`/api${url}`, {
    credentials: "same-origin",
    ...init,
    headers: {
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...init?.headers,
    },
  })

  if (!res.ok) {
    let code = "error"
    try {
      const body = (await res.json()) as { error?: string }
      code = body.error ?? code
    } catch {
      // non-JSON error body
    }
    if (res.status === 401) redirectToLoginOn401(url)
    throw new ApiError(res.status, code)
  }

  if (res.status === 204) return undefined as T
  return res.json() as Promise<T>
}

export interface AuthStatus {
  authenticated: true
}

export function fetchMe(): Promise<AuthStatus> {
  return fetchJSON<AuthStatus>("/auth/me")
}

export function login(password: string): Promise<AuthStatus> {
  return fetchJSON<AuthStatus>("/auth/login", { method: "POST", body: JSON.stringify({ password }) })
}

export function logout(): Promise<void> {
  return fetchJSON<void>("/auth/logout", { method: "POST" })
}
