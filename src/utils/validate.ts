export function validateChatRequest(body: any) {
  if (!body) return "Body missing"

  if (typeof body.message !== "string") {
    return "message must be a string"
  }

  if (body.message.length > 2000) {
    return "message too long"
  }

  return null
}