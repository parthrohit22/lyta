export function getCookieSession(request: Request): string | null {
  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;

  const match = cookie.match(/sessionId=([^;]+)/);
  return match ? match[1] : null;
}

export function createSessionId(): string {
  return crypto.randomUUID();
}

export function setSessionCookie(sessionId: string): string {
  return `sessionId=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`;
}