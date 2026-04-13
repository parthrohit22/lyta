const AUTH_COOKIE_NAME = "lyta_auth"
const AUTH_COOKIE_MAX_AGE = 60 * 60 * 24 * 30
const GUEST_COOKIE_NAME = "lyta_guest"

export function getAuthToken(request: Request): string | null {
  return getCookieValue(request, AUTH_COOKIE_NAME)
}

export function getGuestToken(request: Request): string | null {
  return getCookieValue(request, GUEST_COOKIE_NAME)
}

export function setAuthCookie(token: string, requestUrl?: string): string {
  return buildCookie([
    `${AUTH_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${AUTH_COOKIE_MAX_AGE}`,
    "HttpOnly",
    "SameSite=Lax"
  ], requestUrl)
}

export function clearAuthCookie(requestUrl?: string): string {
  return buildCookie([
    `${AUTH_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax"
  ], requestUrl)
}

export function setGuestCookie(token: string, requestUrl?: string): string {
  return buildCookie([
    `${GUEST_COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax"
  ], requestUrl)
}

export function clearGuestCookie(requestUrl?: string): string {
  return buildCookie([
    `${GUEST_COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Lax"
  ], requestUrl)
}

function getCookieValue(request: Request, name: string) {
  const cookie = request.headers.get("Cookie")

  if (!cookie) {
    return null
  }

  const match = cookie.match(
    new RegExp(`${name}=([^;]+)`)
  )

  return match ? decodeURIComponent(match[1]) : null
}

function buildCookie(parts: string[], requestUrl?: string) {
  if (shouldUseSecureCookie(requestUrl)) {
    parts.push("Secure")
  }

  return parts.join("; ")
}

function shouldUseSecureCookie(requestUrl?: string) {
  if (!requestUrl) {
    return true
  }

  const url = new URL(requestUrl)

  return url.protocol === "https:"
}
