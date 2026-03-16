export function getSessionId(request: Request) {

  const url = new URL(request.url)

  const session =
    url.searchParams.get("session")

  if(session){
    return session
  }

  return crypto.randomUUID()
}