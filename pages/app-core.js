window.LytaCore = (() => {
  const MAX_ATTACHMENTS = 4
  const ACTIVE_SESSION_KEY = "lyta_active_session"

  const DEFAULT_PROFILE = {
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
  ]

  const THEME_PRESETS = {
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

  const DEFAULT_PREFERENCES = {
    theme: { ...THEME_PRESETS.atelier },
    ui: {
      sidebarHidden: false,
      boardOpen: true,
      chatMode: "instant"
    }
  }

  function normalizeChatModeValue(value) {
    return value === "deep" || value === "creative" ? value : "instant"
  }

  function getChatModeLabel(mode) {
    switch (normalizeChatModeValue(mode)) {
      case "deep":
        return "Deep"
      case "creative":
        return "Creative"
      default:
        return "Instant"
    }
  }

  function normalizeMessageRecord(message) {
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

  function normalizeAttachments(value) {
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

  function normalizeCitations(value) {
    if (!Array.isArray(value)) {
      return []
    }

    return value
      .filter(Boolean)
      .map((citation, index) => ({
        id:
          typeof citation?.id === "string"
            ? citation.id
            : `source-${index + 1}`,
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
          typeof citation?.snippet === "string"
            ? citation.snippet.trim()
            : ""
      }))
      .filter(citation => citation.snippet)
  }

  function normalizeFollowups(value) {
    return Array.isArray(value)
      ? value
          .filter(item => typeof item === "string")
          .map(item => item.trim())
          .filter(Boolean)
          .slice(0, 3)
      : []
  }

  function normalizeSessions(value) {
    return Array.isArray(value)
      ? value.map(normalizeSessionRecord).filter(Boolean)
      : []
  }

  function normalizeSessionRecord(value) {
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

  function normalizeProfile(profile, user) {
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
          : user?.email || ""
    }
  }

  function normalizePreferences(preferences) {
    return {
      theme: sanitizeThemeConfig(preferences?.theme || THEME_PRESETS.atelier),
      ui: {
        sidebarHidden: Boolean(preferences?.ui?.sidebarHidden),
        boardOpen: preferences?.ui?.boardOpen !== false,
        chatMode: normalizeChatModeValue(preferences?.ui?.chatMode)
      }
    }
  }

  function normalizeLibraryFiles(value) {
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
        typeof file?.extractedText === "string"
          ? file.extractedText
          : "",
      createdAt: typeof file?.createdAt === "string" ? file.createdAt : timestamp,
      updatedAt: typeof file?.updatedAt === "string" ? file.updatedAt : timestamp
    }))
  }

  function sanitizeThemeConfig(value) {
    const theme = {}

    THEME_KEYS.forEach(key => {
      theme[key] = normalizeHexColor(value?.[key], THEME_PRESETS.atelier[key])
    })

    return theme
  }

  function buildThemeStyles(theme) {
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

  function toSingleLine(text, limit) {
    return (text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, limit)
  }

  function formatMimeLabel(mimeType) {
    if (!mimeType) {
      return "File"
    }

    const label = mimeType.split("/").pop() || mimeType
    return label.replace(/[-+.]/g, " ").toUpperCase()
  }

  function formatBytes(size) {
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

  function formatRelativeTime(iso) {
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

  function renderMarkdown(markdown, fallback = "") {
    const source = markdown || fallback
    const rendered =
      window.marked?.parse(source) ||
      escapeHtml(source)

    return window.DOMPurify?.sanitize(rendered) || rendered
  }

  function setStatusState(element, message, stateName = "neutral", fallback = "") {
    element.textContent = message || fallback

    if (stateName === "neutral") {
      delete element.dataset.state
      return
    }

    element.dataset.state = stateName
  }

  function normalizeHexColor(value, fallback) {
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

  function readableTextColor(hex) {
    return isLightColor(hex) ? "#1d1f1d" : "#f8fafc"
  }

  function isLightColor(hex) {
    const { r, g, b } = hexToRgb(hex)
    const luminance =
      (0.2126 * srgbChannel(r)) +
      (0.7152 * srgbChannel(g)) +
      (0.0722 * srgbChannel(b))

    return luminance > 0.54
  }

  function srgbChannel(value) {
    const normalized = value / 255
    return normalized <= 0.03928
      ? normalized / 12.92
      : ((normalized + 0.055) / 1.055) ** 2.4
  }

  function alphaColor(hex, alpha) {
    const { r, g, b } = hexToRgb(hex)
    return `rgba(${r}, ${g}, ${b}, ${alpha})`
  }

  function hexToRgb(hex) {
    return {
      r: Number.parseInt(hex.slice(1, 3), 16),
      g: Number.parseInt(hex.slice(3, 5), 16),
      b: Number.parseInt(hex.slice(5, 7), 16)
    }
  }

  function getInitials(name) {
    return (name || "LY")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map(part => part[0]?.toUpperCase() || "")
      .join("") || "LY"
  }

  function hasDraggedFiles(event) {
    return Array.from(event.dataTransfer?.types || []).includes("Files")
  }

  function escapeHtml(text) {
    return (text || "").replace(/[&<>"']/g, character => {
      const entities = {
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        "\"": "&quot;",
        "'": "&#39;"
      }

      return entities[character]
    })
  }

  function getErrorMessage(error, fallback = "Something went wrong.") {
    return error instanceof Error && error.message
      ? error.message
      : fallback
  }

  function cloneAttachment(attachment) {
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

  function clonePreferences(preferences) {
    return {
      theme: { ...preferences.theme },
      ui: { ...preferences.ui }
    }
  }

  function slugify(value) {
    return (value || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48)
  }

  async function apiJson(path, options = {}) {
    const response = await fetch(path, {
      ...options,
      headers: {
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...(options.headers || {})
      }
    })

    if (!response.ok) {
      throw new Error((await response.text()) || "Request failed.")
    }

    return response.json()
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
