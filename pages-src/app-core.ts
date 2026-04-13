// Source for pages/app-core.js while the browser client migrates to TypeScript.
type ChatMode = "instant" | "deep" | "creative"
type AttachmentKind = "image" | "document"
type ThemeKey =
  | "background"
  | "sidebar"
  | "topbar"
  | "conversation"
  | "composer"
  | "assistantBubble"
  | "userBubble"
  | "accent"
type ThemePresetName = "atelier" | "harbor" | "linen"
type LooseRecord = Record<string, unknown> | null | undefined

interface ThemeConfig {
  background: string
  sidebar: string
  topbar: string
  conversation: string
  composer: string
  assistantBubble: string
  userBubble: string
  accent: string
}

interface Preferences {
  theme: ThemeConfig
  ui: {
    sidebarHidden: boolean
    boardOpen: boolean
    chatMode: ChatMode
  }
}

interface Profile {
  name: string
  workspace: string
  email: string
}

interface MessageAttachment {
  id: string
  libraryFileId: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
  summary: string
  dataUrl: string
  extractedText: string
}

interface Citation {
  id: string
  label: string
  fileId: string
  fileName: string
  snippet: string
}

interface MessageRecord {
  id: string
  role: "assistant" | "user"
  content: string
  mode: ChatMode
  attachments: MessageAttachment[]
  citations: Citation[]
  followups: string[]
}

interface SessionRecord {
  id: string
  title: string
  createdAt: string
  updatedAt: string
}

interface LibraryFile {
  libraryFileId: string
  kind: AttachmentKind
  name: string
  mimeType: string
  size: number
  summary: string
  dataUrl: string
  extractedText: string
  createdAt: string
  updatedAt: string
}

interface ThemeStylesResult {
  theme: ThemeConfig
  styles: Record<string, string>
}

interface MarkedApi {
  parse(source: string): string
}

interface DOMPurifyApi {
  sanitize(source: string): string
}

interface LytaCoreApi {
  MAX_ATTACHMENTS: number
  ACTIVE_SESSION_KEY: string
  DEFAULT_PROFILE: Profile
  THEME_KEYS: readonly ThemeKey[]
  THEME_PRESETS: Record<ThemePresetName, ThemeConfig>
  DEFAULT_PREFERENCES: Preferences
  normalizeChatModeValue(value: unknown): ChatMode
  getChatModeLabel(mode: unknown): string
  normalizeMessageRecord(message: LooseRecord): MessageRecord
  normalizeCitations(value: unknown): Citation[]
  normalizeFollowups(value: unknown): string[]
  normalizeSessions(value: unknown): SessionRecord[]
  normalizeSessionRecord(value: LooseRecord): SessionRecord | null
  normalizeProfile(profile: LooseRecord, user?: LooseRecord): Profile
  normalizePreferences(preferences: LooseRecord): Preferences
  normalizeLibraryFiles(value: unknown): LibraryFile[]
  sanitizeThemeConfig(value: LooseRecord): ThemeConfig
  buildThemeStyles(theme: LooseRecord): ThemeStylesResult
  toSingleLine(text: string | null | undefined, limit: number): string
  formatMimeLabel(mimeType: string | null | undefined): string
  formatBytes(size: number | null | undefined): string
  formatRelativeTime(iso: string | null | undefined): string
  renderMarkdown(markdown: string | null | undefined, fallback?: string): string
  setStatusState(
    element: HTMLElement,
    message: string | null | undefined,
    stateName?: string,
    fallback?: string
  ): void
  getInitials(name: string | null | undefined): string
  hasDraggedFiles(event: { dataTransfer?: DataTransfer | null }): boolean
  getErrorMessage(error: unknown, fallback?: string): string
  cloneAttachment(attachment: MessageAttachment): MessageAttachment
  clonePreferences(preferences: Preferences): Preferences
  slugify(value: string | null | undefined): string
  apiJson<T = unknown>(path: string, options?: RequestInit): Promise<T>
}

interface Window {
  marked?: MarkedApi
  DOMPurify?: DOMPurifyApi
  LytaCore: LytaCoreApi
}

window.LytaCore = ((): LytaCoreApi => {
  const MAX_ATTACHMENTS = 4
  const ACTIVE_SESSION_KEY = "lyta_active_session"

  const DEFAULT_PROFILE: Profile = {
    name: "Guest User",
    workspace: "Private Workspace",
    email: ""
  }

  const THEME_KEYS = [
    "background",
    "sidebar",
    "topbar",
    "conversation",
    "composer",
    "assistantBubble",
    "userBubble",
    "accent"
  ] as const satisfies readonly ThemeKey[]

  const THEME_PRESETS: Record<ThemePresetName, ThemeConfig> = {
    atelier: {
      background: "#f2ede3",
      sidebar: "#faf5ec",
      topbar: "#fffaf0",
      conversation: "#fffdf8",
      composer: "#fff8ef",
      assistantBubble: "#fff4e8",
      userBubble: "#1f6b72",
      accent: "#c35d3f"
    },
    harbor: {
      background: "#e7efe9",
      sidebar: "#eff6f1",
      topbar: "#f7fbf8",
      conversation: "#fcfffd",
      composer: "#f5fbf8",
      assistantBubble: "#ffffff",
      userBubble: "#235b66",
      accent: "#5a7d59"
    },
    linen: {
      background: "#f3f0ec",
      sidebar: "#fbfaf7",
      topbar: "#fffdfa",
      conversation: "#fdfbf8",
      composer: "#fffdf9",
      assistantBubble: "#fff8f2",
      userBubble: "#8a4f3d",
      accent: "#9c6d2d"
    }
  }

  const DEFAULT_PREFERENCES: Preferences = {
    theme: { ...THEME_PRESETS.atelier },
    ui: {
      sidebarHidden: false,
      boardOpen: true,
      chatMode: "instant"
    }
  }

  function normalizeChatModeValue(value: unknown): ChatMode {
    return value === "deep" || value === "creative" ? value : "instant"
  }

  function getChatModeLabel(mode: unknown): string {
    switch (normalizeChatModeValue(mode)) {
      case "deep":
        return "Deep"
      case "creative":
        return "Creative"
      default:
        return "Instant"
    }
  }

  function normalizeMessageRecord(message: LooseRecord): MessageRecord {
    return {
      id: typeof message?.id === "string" ? message.id : crypto.randomUUID(),
      role: message?.role === "assistant" ? "assistant" : "user",
      content: typeof message?.content === "string" ? message.content : "",
      mode: normalizeChatModeValue(message?.mode),
      attachments: normalizeAttachments(message?.attachments),
      citations: normalizeCitations(message?.citations),
      followups: normalizeFollowups(message?.followups)
    }
  }

  function normalizeAttachments(value: unknown): MessageAttachment[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value.map(attachment => ({
      id: typeof attachment?.id === "string" ? attachment.id : crypto.randomUUID(),
      libraryFileId:
        typeof attachment?.libraryFileId === "string"
          ? attachment.libraryFileId
          : "",
      kind: attachment?.kind === "image" ? "image" : "document",
      name:
        typeof attachment?.name === "string" && attachment.name.trim()
          ? attachment.name.trim()
          : "Attachment",
      mimeType:
        typeof attachment?.mimeType === "string" && attachment.mimeType.trim()
          ? attachment.mimeType.trim()
          : "application/octet-stream",
      size: Number.isFinite(attachment?.size) ? attachment.size : 0,
      summary: typeof attachment?.summary === "string" ? attachment.summary : "",
      dataUrl: typeof attachment?.dataUrl === "string" ? attachment.dataUrl : "",
      extractedText:
        typeof attachment?.extractedText === "string"
          ? attachment.extractedText
          : ""
    }))
  }

  function normalizeCitations(value: unknown): Citation[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value
      .filter(Boolean)
      .map((citation, index) => ({
        id:
          typeof citation?.id === "string" ? citation.id : `source-${index + 1}`,
        label:
          typeof citation?.label === "string" && citation.label.trim()
            ? citation.label.trim()
            : `Source ${index + 1}`,
        fileId: typeof citation?.fileId === "string" ? citation.fileId : "",
        fileName:
          typeof citation?.fileName === "string" && citation.fileName.trim()
            ? citation.fileName.trim()
            : "Attachment",
        snippet:
          typeof citation?.snippet === "string" ? citation.snippet.trim() : ""
      }))
      .filter(citation => citation.snippet)
  }

  function normalizeFollowups(value: unknown): string[] {
    return Array.isArray(value)
      ? value
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
  }

  function normalizeSessions(value: unknown): SessionRecord[] {
    if (!Array.isArray(value)) {
      return []
    }

    return value
      .map(normalizeSessionRecord)
      .filter((session): session is SessionRecord => Boolean(session))
  }

  function normalizeSessionRecord(value: LooseRecord): SessionRecord | null {
    if (typeof value?.id !== "string" || !value.id) {
      return null
    }

    const timestamp = new Date().toISOString()

    return {
      id: value.id,
      title:
        typeof value?.title === "string" && value.title.trim()
          ? value.title.trim()
          : "New Chat",
      createdAt: typeof value?.createdAt === "string" ? value.createdAt : timestamp,
      updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : timestamp
    }
  }

  function normalizeProfile(profile: LooseRecord, user?: LooseRecord): Profile {
    return {
      name:
        typeof profile?.name === "string" && profile.name.trim()
          ? profile.name.trim()
          : DEFAULT_PROFILE.name,
      workspace:
        typeof profile?.workspace === "string" && profile.workspace.trim()
          ? profile.workspace.trim()
          : DEFAULT_PROFILE.workspace,
      email:
        typeof profile?.email === "string" && profile.email.trim()
          ? profile.email.trim()
          : typeof user?.email === "string"
            ? user.email
            : ""
    }
  }

  function normalizePreferences(preferences: LooseRecord): Preferences {
    return {
      theme: sanitizeThemeConfig(preferences?.theme as LooseRecord),
      ui: {
        sidebarHidden: Boolean(preferences?.ui && (preferences.ui as LooseRecord)?.sidebarHidden),
        boardOpen: (preferences?.ui as LooseRecord)?.boardOpen !== false,
        chatMode: normalizeChatModeValue((preferences?.ui as LooseRecord)?.chatMode)
      }
    }
  }

  function normalizeLibraryFiles(value: unknown): LibraryFile[] {
    if (!Array.isArray(value)) {
      return []
    }

    const timestamp = new Date().toISOString()

    return value.map(file => ({
      libraryFileId:
        typeof file?.libraryFileId === "string"
          ? file.libraryFileId
          : crypto.randomUUID(),
      kind: file?.kind === "image" ? "image" : "document",
      name:
        typeof file?.name === "string" && file.name.trim()
          ? file.name.trim()
          : "Attachment",
      mimeType:
        typeof file?.mimeType === "string" && file.mimeType.trim()
          ? file.mimeType.trim()
          : "application/octet-stream",
      size: Number.isFinite(file?.size) ? file.size : 0,
      summary: typeof file?.summary === "string" ? file.summary : "",
      dataUrl: typeof file?.dataUrl === "string" ? file.dataUrl : "",
      extractedText:
        typeof file?.extractedText === "string" ? file.extractedText : "",
      createdAt: typeof file?.createdAt === "string" ? file.createdAt : timestamp,
      updatedAt: typeof file?.updatedAt === "string" ? file.updatedAt : timestamp
    }))
  }

  function sanitizeThemeConfig(value: LooseRecord): ThemeConfig {
    const theme = {} as ThemeConfig
    const source =
      value && typeof value === "object"
        ? (value as Partial<Record<ThemeKey, unknown>>)
        : undefined

    THEME_KEYS.forEach(key => {
      theme[key] = normalizeHexColor(source?.[key], THEME_PRESETS.atelier[key])
    })

    return theme
  }

  function buildThemeStyles(theme: LooseRecord): ThemeStylesResult {
    const nextTheme = sanitizeThemeConfig(theme)
    const pageText = readableTextColor(nextTheme.background)
    const sidebarText = readableTextColor(nextTheme.sidebar)
    const topbarText = readableTextColor(nextTheme.topbar)
    const conversationText = readableTextColor(nextTheme.conversation)
    const composerText = readableTextColor(nextTheme.composer)
    const assistantText = readableTextColor(nextTheme.assistantBubble)
    const userText = readableTextColor(nextTheme.userBubble)
    const accentText = readableTextColor(nextTheme.accent)

    return {
      theme: nextTheme,
      styles: {
        "--app-background": nextTheme.background,
        "--sidebar-background": nextTheme.sidebar,
        "--topbar-background": nextTheme.topbar,
        "--conversation-background": nextTheme.conversation,
        "--composer-background": nextTheme.composer,
        "--assistant-bubble": nextTheme.assistantBubble,
        "--user-bubble": nextTheme.userBubble,
        "--accent": nextTheme.accent,
        "--page-text": pageText,
        "--page-muted": alphaColor(pageText, 0.66),
        "--sidebar-text": sidebarText,
        "--sidebar-muted": alphaColor(sidebarText, 0.68),
        "--topbar-text": topbarText,
        "--topbar-muted": alphaColor(topbarText, 0.66),
        "--conversation-text": conversationText,
        "--conversation-muted": alphaColor(conversationText, 0.68),
        "--composer-text": composerText,
        "--composer-muted": alphaColor(composerText, 0.68),
        "--assistant-text": assistantText,
        "--user-text": userText,
        "--accent-text": accentText,
        "--line-color": alphaColor(pageText, 0.12),
        "--line-strong": alphaColor(pageText, 0.2),
        "--accent-soft": alphaColor(nextTheme.accent, 0.14),
        "--shadow": `0 18px 48px ${alphaColor(pageText, isLightColor(nextTheme.background) ? 0.08 : 0.18)}`
      }
    }
  }

  function toSingleLine(text: string | null | undefined, limit: number): string {
    return (text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit)
  }

  function formatMimeLabel(mimeType: string | null | undefined): string {
    if (!mimeType) {
      return "File"
    }

    const label = mimeType.split("/").pop() || mimeType
    return label.replace(/[-+.]/g, " ").toUpperCase()
  }

  function formatBytes(size: number | null | undefined): string {
    if (!size) {
      return "0 B"
    }

    const units = ["B", "KB", "MB", "GB"]
    let value = size
    let index = 0

    while (value >= 1024 && index < units.length - 1) {
      value /= 1024
      index += 1
    }

    return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`
  }

  function formatRelativeTime(iso: string | null | undefined): string {
    if (!iso) {
      return "Recently"
    }

    const delta = Date.now() - new Date(iso).getTime()

    if (!Number.isFinite(delta)) {
      return "Recently"
    }

    const minute = 60_000
    const hour = minute * 60
    const day = hour * 24

    if (delta < minute) return "Just now"
    if (delta < hour) return `${Math.round(delta / minute)}m ago`
    if (delta < day) return `${Math.round(delta / hour)}h ago`
    return `${Math.round(delta / day)}d ago`
  }

  function renderMarkdown(
    markdown: string | null | undefined,
    fallback = ""
  ): string {
    const source = markdown || fallback
    const rendered = window.marked?.parse(source) || escapeHtml(source)

    return window.DOMPurify?.sanitize(rendered) || rendered
  }

  function setStatusState(
    element: HTMLElement,
    message: string | null | undefined,
    stateName = "neutral",
    fallback = ""
  ): void {
    element.textContent = message || fallback

    if (stateName === "neutral") {
      delete element.dataset.state
      return
    }

    element.dataset.state = stateName
  }

  function normalizeHexColor(value: unknown, fallback: string): string {
    if (typeof value !== "string") {
      return fallback
    }

    const trimmed = value.trim()

    if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) {
      return trimmed.toLowerCase()
    }

    if (/^#[0-9a-fA-F]{3}$/.test(trimmed)) {
      return `#${trimmed[1]}${trimmed[1]}${trimmed[2]}${trimmed[2]}${trimmed[3]}${trimmed[3]}`.toLowerCase()
    }

    return fallback
  }

  function readableTextColor(hex: string): string {
    return isLightColor(hex) ? "#1d1f1d" : "#f8fafc"
  }

  function isLightColor(hex: string): boolean {
    const { r, g, b } = hexToRgb(hex)
    const luminance =
      0.2126 * srgbChannel(r) +
      0.7152 * srgbChannel(g) +
      0.0722 * srgbChannel(b)

    return luminance > 0.54
  }

  function srgbChannel(value: number): number {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  function alphaColor(hex: string, alpha: number): string {
    const { r, g, b } = hexToRgb(hex)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  function hexToRgb(hex: string): { r: number; g: number; b: number } {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16)
    }
  }

  function getInitials(name: string | null | undefined): string {
    return (
      (name || "LY")
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map(part => part[0]?.toUpperCase() || "")
        .join("") || "LY"
    )
  }

  function hasDraggedFiles(event: {
    dataTransfer?: DataTransfer | null
  }): boolean {
    return Array.from(event.dataTransfer?.types || []).includes("Files")
  }

  function escapeHtml(text: string | null | undefined): string {
    return (text || "").replace(/[&<>"']/g, character => {
      const entities: Record<string, string> = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }

      return entities[character] || character
    })
  }

  function getErrorMessage(
    error: unknown,
    fallback = "Something went wrong."
  ): string {
    return error instanceof Error && error.message ? error.message : fallback
  }

  function cloneAttachment(attachment: MessageAttachment): MessageAttachment {
    return {
      id: attachment.id,
      libraryFileId: attachment.libraryFileId || "",
      kind: attachment.kind,
      name: attachment.name,
      mimeType: attachment.mimeType,
      size: attachment.size,
      summary: attachment.summary,
      dataUrl: attachment.dataUrl,
      extractedText: attachment.extractedText
    }
  }

  function clonePreferences(preferences: Preferences): Preferences {
    return {
      theme: { ...preferences.theme },
      ui: { ...preferences.ui }
    }
  }

  function slugify(value: string | null | undefined): string {
    return (value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
  }

  async function apiJson<T = unknown>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers = new Headers(options.headers || undefined)

    if (options.body && !headers.has("Content-Type")) {
      headers.set("Content-Type", "application/json")
    }

    const response = await fetch(path, {
      ...options,
      headers
    })

    if (!response.ok) {
      throw new Error((await response.text()) || "Request failed.")
    }

    return response.json() as Promise<T>
  }

  return {
    MAX_ATTACHMENTS,
    ACTIVE_SESSION_KEY,
    DEFAULT_PROFILE,
    THEME_KEYS,
    THEME_PRESETS,
    DEFAULT_PREFERENCES,
    normalizeChatModeValue,
    getChatModeLabel,
    normalizeMessageRecord,
    normalizeCitations,
    normalizeFollowups,
    normalizeSessions,
    normalizeSessionRecord,
    normalizeProfile,
    normalizePreferences,
    normalizeLibraryFiles,
    sanitizeThemeConfig,
    buildThemeStyles,
    toSingleLine,
    formatMimeLabel,
    formatBytes,
    formatRelativeTime,
    renderMarkdown,
    setStatusState,
    getInitials,
    hasDraggedFiles,
    getErrorMessage,
    cloneAttachment,
    clonePreferences,
    slugify,
    apiJson
  }
})()
