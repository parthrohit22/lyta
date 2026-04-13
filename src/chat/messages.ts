import type { LibraryCitation } from "../library/chunks"
import type { AiChatMessage } from "../services/ai"

const MAX_MESSAGE_LENGTH = 4000
const MAX_ATTACHMENTS = 4
const MAX_ATTACHMENT_ID_LENGTH = 120
const MAX_ATTACHMENT_NAME_LENGTH = 120
const MAX_ATTACHMENT_MIME_LENGTH = 120
const MAX_ATTACHMENT_SUMMARY_LENGTH = 280
const MAX_DOC_TEXT_LENGTH = 16000
const MAX_IMAGE_DATA_URL_LENGTH = 2_400_000
const MAX_RETRIEVAL_TEXT_LENGTH = 1800
const MAX_TITLE_TEXT_LENGTH = 1200
const MAX_SUMMARY_DOC_LENGTH = 2400
const MAX_WORKSPACE_CONTEXT_LENGTH = 4800
const MAX_FOLLOWUP_LENGTH = 90
const MAX_FOLLOWUPS = 3
const TITLE_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "how",
  "i",
  "in",
  "into",
  "is",
  "it",
  "me",
  "my",
  "of",
  "on",
  "or",
  "our",
  "please",
  "show",
  "that",
  "the",
  "this",
  "to",
  "us",
  "what",
  "with",
  "you",
  "your"
])

export type ChatRole = "user" | "assistant"
export type AttachmentKind = "image" | "document"
export type ChatMode = "instant" | "deep" | "creative"

const CHAT_MODE_VALUES: ChatMode[] = [
  "instant",
  "deep",
  "creative"
]

const MODE_SYSTEM_PROMPTS: Record<ChatMode, string> = {
  instant:
    "Mode: Instant. Respond quickly and clearly. Prioritize the direct answer first, keep it compact, and avoid unnecessary detours.",
  deep:
    "Mode: Deep. Think carefully, reason through tradeoffs, and give a more rigorous answer. State key assumptions, catch edge cases, and end with a concise recommendation.",
  creative:
    "Mode: Creative. Keep the answer useful and grounded, but explore fresh angles, stronger phrasing, alternative directions, or more imaginative options where appropriate."
}

function systemMessage(content: string): AiChatMessage {
  return {
    role: "system",
    content
  }
}

export interface ChatAttachment {
  id: string
  libraryFileId?: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
  summary?: string
  dataUrl?: string
  extractedText?: string
}

export interface ChatMessageRecord {
  id?: string
  role: ChatRole
  content: string
  mode?: ChatMode
  attachments?: ChatAttachment[]
  citations?: LibraryCitation[]
  followups?: string[]
  createdAt?: string
}

export interface ChatRequestBody {
  message?: string
  mode?: ChatMode
  attachments?: ChatAttachment[]
}

export interface ConversationRequestBody extends ChatRequestBody {
  userId?: string
  sessionId?: string
  workspaceContext?: string
  citations?: LibraryCitation[]
}

export function validateChatRequest(body: unknown) {
  if (!body || typeof body !== "object") {
    return "Body missing"
  }

  const payload = body as ChatRequestBody

  if (payload.message != null && typeof payload.message !== "string") {
    return "message must be a string"
  }

  if (payload.attachments != null && !Array.isArray(payload.attachments)) {
    return "attachments must be an array"
  }

  if (
    payload.mode != null &&
    !CHAT_MODE_VALUES.includes(payload.mode)
  ) {
    return "mode must be instant, deep, or creative"
  }

  const message = normalizeMessage(payload.message ?? "")
  const attachments = Array.isArray(payload.attachments)
    ? payload.attachments
    : []

  if (!message && !attachments.length) {
    return "Message or attachment required"
  }

  if (attachments.length > MAX_ATTACHMENTS) {
    return `Maximum ${MAX_ATTACHMENTS} attachments allowed`
  }

  for (const attachment of attachments) {
    if (!attachment || typeof attachment !== "object") {
      return "attachment must be an object"
    }

    if (attachment.kind !== "image" && attachment.kind !== "document") {
      return "attachment kind must be image or document"
    }

    if (typeof attachment.name !== "string" || !attachment.name.trim()) {
      return "attachment name is required"
    }

    if (typeof attachment.mimeType !== "string" || !attachment.mimeType.trim()) {
      return "attachment mimeType is required"
    }

    if (!Number.isFinite(attachment.size) || attachment.size < 0) {
      return "attachment size must be a non-negative number"
    }

    if (
      attachment.summary != null &&
      typeof attachment.summary !== "string"
    ) {
      return "attachment summary must be a string"
    }

    if (attachment.kind === "image") {
      if (typeof attachment.dataUrl !== "string") {
        return "image attachment dataUrl is required"
      }

      if (!attachment.dataUrl.startsWith("data:image/")) {
        return "image attachment must use a data:image URI"
      }

      if (attachment.dataUrl.length > MAX_IMAGE_DATA_URL_LENGTH) {
        return "image attachment is too large"
      }
    }

    if (
      attachment.kind === "document" &&
      attachment.extractedText != null &&
      typeof attachment.extractedText !== "string"
    ) {
      return "document extractedText must be a string"
    }
  }

  return null
}

export function normalizeChatRequest(body: ChatRequestBody) {
  return {
    message: normalizeMessage(body.message ?? ""),
    mode: normalizeChatMode(body.mode),
    attachments: (body.attachments ?? [])
      .slice(0, MAX_ATTACHMENTS)
      .map(normalizeAttachment)
  }
}

export function createAssistantMessage(
  content: string,
  options?: {
    mode?: ChatMode
    citations?: LibraryCitation[]
    followups?: string[]
  }
): ChatMessageRecord {
  return {
    role: "assistant",
    content: content.trim(),
    ...(options?.mode ? { mode: options.mode } : {}),
    ...(options?.citations?.length
      ? { citations: normalizeLibraryCitations(options.citations) }
      : {}),
    ...(options?.followups?.length
      ? { followups: normalizeFollowups(options.followups) }
      : {}),
    createdAt: new Date().toISOString()
  }
}

export function buildConversationMessages(input: {
  recent: ChatMessageRecord[]
  mode: ChatMode
  summary?: string
  retrievedContext?: string
}): AiChatMessage[] {
  return [
    systemMessage(
      "You are LYTA, an edge-native AI workspace running on Cloudflare Workers. Deliver polished, practical answers with GPT-style clarity. Lead with the most useful answer, adapt depth to the task, use clean structure when it helps, and avoid filler. You can analyze attached images and extracted document text. If a document excerpt appears partial or truncated, say so clearly and work from the available material. When source blocks labelled like [Source 1] are provided, cite them inline only when they directly support the statement."
    ),
    systemMessage(MODE_SYSTEM_PROMPTS[input.mode]),
    ...(input.retrievedContext
      ? [systemMessage(`Relevant project context:\n${input.retrievedContext}`)]
      : []),
    ...(input.summary
      ? [systemMessage(`Conversation summary:\n${input.summary}`)]
      : []),
    ...input.recent.map(toAiMessage)
  ]
}

export function buildSummaryMessages(recent: ChatMessageRecord[]): AiChatMessage[] {
  return recent.map(message => ({
    role: message.role,
    content: buildTextOnlyMessage(message, MAX_SUMMARY_DOC_LENGTH)
  }))
}

export function buildTitleSource(message: ChatMessageRecord) {
  return buildTextOnlyMessage(message, MAX_TITLE_TEXT_LENGTH)
}

export function createConversationTitle(
  rawTitle: string | undefined,
  message: ChatMessageRecord
) {
  return (
    normalizeGeneratedTitle(rawTitle) ||
    buildFallbackTitle(message) ||
    "New Chat"
  )
}

export function buildRetrievalQuery(message: ChatMessageRecord) {
  return buildTextOnlyMessage(message, 800).slice(0, MAX_RETRIEVAL_TEXT_LENGTH)
}

export function normalizeWorkspaceContext(value: string | undefined) {
  return normalizeTextBlock(value, MAX_WORKSPACE_CONTEXT_LENGTH)
}

export function normalizeLibraryCitations(
  citations: LibraryCitation[] | undefined
) {
  return (Array.isArray(citations) ? citations : [])
    .filter(Boolean)
    .map((citation, index) => ({
      id:
        normalizeInlineText(
          citation.id || `source-${index + 1}`,
          MAX_ATTACHMENT_ID_LENGTH
        ) || `source-${index + 1}`,
      label:
        normalizeInlineText(citation.label || `Source ${index + 1}`, 40) ||
        `Source ${index + 1}`,
      fileId: normalizeInlineText(citation.fileId || "", MAX_ATTACHMENT_ID_LENGTH),
      fileName:
        normalizeInlineText(citation.fileName || "Attachment", MAX_ATTACHMENT_NAME_LENGTH) ||
        "Attachment",
      snippet:
        normalizeTextBlock(
          citation.snippet || "",
          MAX_ATTACHMENT_SUMMARY_LENGTH
        ) || ""
    }))
    .filter(citation => citation.fileName && citation.snippet)
    .slice(0, 4)
}

export function normalizeFollowups(followups: string[] | undefined) {
  return (Array.isArray(followups) ? followups : [])
    .filter(value => typeof value === "string")
    .map(value => normalizeInlineText(value, MAX_FOLLOWUP_LENGTH))
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index)
    .slice(0, MAX_FOLLOWUPS)
}

export function createConversationFollowups(
  rawOutput: string | undefined,
  message: ChatMessageRecord
) {
  const parsed = normalizeFollowups(parseFollowupCandidates(rawOutput))

  if (parsed.length) {
    return parsed
  }

  const fallback = buildFallbackFollowups(message)

  return normalizeFollowups(fallback)
}

export function normalizeChatMode(mode: ChatMode | undefined): ChatMode {
  return CHAT_MODE_VALUES.includes(mode as ChatMode)
    ? (mode as ChatMode)
    : "instant"
}

export function getChatModeLabel(mode: ChatMode | undefined) {
  switch (normalizeChatMode(mode)) {
    case "deep":
      return "Deep"
    case "creative":
      return "Creative"
    default:
      return "Instant"
  }
}

function normalizeAttachment(attachment: ChatAttachment): ChatAttachment {
  const kind = attachment.kind === "image" ? "image" : "document"

  return {
    id:
      normalizeInlineText(
        attachment.id || crypto.randomUUID(),
        MAX_ATTACHMENT_ID_LENGTH
      ) || crypto.randomUUID(),
    libraryFileId:
      normalizeOptionalInlineText(
        attachment.libraryFileId,
        MAX_ATTACHMENT_ID_LENGTH
      ),
    kind,
    name: normalizeInlineText(
      attachment.name || "Attachment",
      MAX_ATTACHMENT_NAME_LENGTH
    ) || "Attachment",
    mimeType: normalizeInlineText(
      attachment.mimeType || "application/octet-stream",
      MAX_ATTACHMENT_MIME_LENGTH
    ) || "application/octet-stream",
    size: normalizeSize(attachment.size),
    summary: normalizeOptionalInlineText(
      attachment.summary,
      MAX_ATTACHMENT_SUMMARY_LENGTH
    ),
    dataUrl:
      kind === "image"
        ? normalizeDataUrl(attachment.dataUrl)
        : undefined,
    extractedText:
      kind === "document"
        ? normalizeTextBlock(attachment.extractedText, MAX_DOC_TEXT_LENGTH)
        : undefined
  }
}

function toAiMessage(message: ChatMessageRecord): AiChatMessage {
  if (message.role === "assistant") {
    return {
      role: message.role,
      content: message.content
    }
  }

  const images =
    message.attachments?.filter(
      attachment => attachment.kind === "image" && !!attachment.dataUrl
    ) || []

  const prompt = buildUserPrompt(message)

  if (!images.length) {
    return {
      role: message.role,
      content: prompt
    }
  }

  return {
    role: message.role,
    content: [
      {
        type: "text",
        text: prompt
      },
      ...images.map(image => ({
        type: "image_url" as const,
        image_url: {
          url: image.dataUrl || ""
        }
      }))
    ]
  }
}

function buildUserPrompt(message: ChatMessageRecord) {
  const sections = [
    `User request:\n${
      message.content.trim() ||
      "Please analyze the attached files and help with the request."
    }`
  ]

  const documentBlocks =
    message.attachments
      ?.filter(attachment => attachment.kind === "document")
      .map(attachment => describeDocument(attachment, MAX_DOC_TEXT_LENGTH)) || []

  if (documentBlocks.length) {
    sections.push(
      `Attached document context:\n${documentBlocks.join("\n\n")}`
    )
  }

  const imageBlocks =
    message.attachments
      ?.filter(attachment => attachment.kind === "image")
      .map(describeImage) || []

  if (imageBlocks.length) {
    sections.push(`Attached images:\n${imageBlocks.join("\n")}`)
  }

  return sections.join("\n\n")
}

function buildTextOnlyMessage(message: ChatMessageRecord, documentLimit: number) {
  const sections: string[] = []

  if (message.content.trim()) {
    sections.push(message.content.trim())
  }

  const documentBlocks =
    message.attachments
      ?.filter(attachment => attachment.kind === "document")
      .map(attachment => describeDocument(attachment, documentLimit)) || []

  if (documentBlocks.length) {
    sections.push(documentBlocks.join("\n\n"))
  }

  const imageBlocks =
    message.attachments
      ?.filter(attachment => attachment.kind === "image")
      .map(describeImage) || []

  if (imageBlocks.length) {
    sections.push(`Images:\n${imageBlocks.join("\n")}`)
  }

  return sections.join("\n\n").trim()
}

function describeDocument(
  attachment: ChatAttachment,
  documentLimit: number
) {
  const lines = [
    `Document: ${attachment.name} (${attachment.mimeType}, ${formatBytes(attachment.size)})`
  ]

  if (attachment.summary) {
    lines.push(`Overview: ${attachment.summary}`)
  }

  if (attachment.extractedText) {
    lines.push(
      `Extracted text:\n${attachment.extractedText.slice(0, documentLimit)}`
    )
  } else {
    lines.push("No extracted text was available for this file.")
  }

  return lines.join("\n")
}

function describeImage(attachment: ChatAttachment) {
  if (attachment.summary) {
    return `- ${attachment.name} (${attachment.summary})`
  }

  return `- ${attachment.name}`
}

function normalizeMessage(value: string) {
  return normalizeTextBlock(value, MAX_MESSAGE_LENGTH)
}

function normalizeTextBlock(value: string | undefined, maxLength: number) {
  if (typeof value !== "string") {
    return ""
  }

  return value
    .replace(/\u0000/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, maxLength)
}

function normalizeInlineText(value: string, maxLength: number) {
  return value
    .replace(/\u0000/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
}

function normalizeOptionalInlineText(
  value: string | undefined,
  maxLength: number
) {
  if (typeof value !== "string") {
    return undefined
  }

  return normalizeInlineText(value, maxLength) || undefined
}

function normalizeDataUrl(value: string | undefined) {
  if (typeof value !== "string") {
    return undefined
  }

  return value.slice(0, MAX_IMAGE_DATA_URL_LENGTH)
}

function normalizeSize(size: number) {
  if (!Number.isFinite(size)) {
    return 0
  }

  return Math.max(0, Math.round(size))
}

function formatBytes(size: number) {
  if (!size) {
    return "0 B"
  }

  const units = ["B", "KB", "MB", "GB"]
  let value = size
  let unitIndex = 0

  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024
    unitIndex += 1
  }

  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1)

  return `${rounded} ${units[unitIndex]}`
}

function normalizeGeneratedTitle(rawTitle: string | undefined) {
  if (!rawTitle) {
    return ""
  }

  const cleaned = rawTitle
    .replace(/[`"'*_#:[\](){},.!?\\/]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()

  if (!cleaned) {
    return ""
  }

  const words = cleaned
    .split(" ")
    .map(part => part.replace(/[^a-zA-Z0-9-]/g, ""))
    .filter(Boolean)
    .slice(0, 3)

  if (words.length < 2) {
    return ""
  }

  return words.map(toTitleWord).join(" ")
}

function buildFallbackTitle(message: ChatMessageRecord) {
  const textParts = [message.content]

  for (const attachment of message.attachments || []) {
    textParts.push(attachment.name)

    if (attachment.summary) {
      textParts.push(attachment.summary)
    }
  }

  const words = textParts
    .join(" ")
    .replace(/\.[a-z0-9]+/gi, " ")
    .match(/[a-zA-Z0-9-]+/g)

  if (!words?.length) {
    return ""
  }

  const picked = words
    .map(word => word.toLowerCase())
    .filter(word => word.length > 2 && !TITLE_STOP_WORDS.has(word))
    .filter((word, index, list) => list.indexOf(word) === index)
    .slice(0, 3)

  if (picked.length >= 2) {
    return picked.map(toTitleWord).join(" ")
  }

  if (picked.length === 1) {
    return `${toTitleWord(picked[0])} Chat`
  }

  return ""
}

function toTitleWord(word: string) {
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()
}

function parseFollowupCandidates(rawOutput: string | undefined) {
  if (!rawOutput) {
    return []
  }

  const trimmed = rawOutput.trim()

  if (!trimmed) {
    return []
  }

  try {
    const parsed = JSON.parse(trimmed)

    if (Array.isArray(parsed)) {
      return parsed.map(value => String(value || ""))
    }
  } catch {}

  return trimmed
    .split(/\n+/)
    .map(line => line.replace(/^[-*\d.)\s]+/, "").trim())
    .filter(Boolean)
}

function buildFallbackFollowups(message: ChatMessageRecord) {
  const attachmentHint = message.attachments?.length
    ? "about the attached file"
    : "in more detail"
  const request = buildFallbackTitle(message)

  return [
    `Can you explain this ${attachmentHint}?`,
    request
      ? `What should I do next for ${request.toLowerCase()}?`
      : "What should I do next?",
    "Can you turn this into an action plan?"
  ]
}
