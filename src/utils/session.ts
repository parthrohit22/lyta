export function getSessionId(body: any): string {
  if (body?.sessionId) {
    return body.sessionId;
  }

  return crypto.randomUUID();
}