const {
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
} = window.LytaCore

const { prepareAttachment } = window.LytaAttachments

const state = {
  user: null,
  profile: { ...DEFAULT_PROFILE },
  preferences: clonePreferences(DEFAULT_PREFERENCES),
  sessions: [],
  sessionId: sessionStorage.getItem(ACTIVE_SESSION_KEY) || "",
  messages: [],
  library: [],
  pendingAttachments: [],
  selectedMessageId: "",
  sending: false,
  authMode: "register",
  uploadTarget: "composer",
  preferenceTimer: null
}

const dom = {
  authOverlay: document.getElementById("authOverlay"),
  authModal: document.getElementById("authModal"),
  closeAuthModal: document.getElementById("closeAuthModal"),
  authForm: document.getElementById("authForm"),
  authNameField: document.getElementById("authNameField"),
  authName: document.getElementById("authName"),
  authEmail: document.getElementById("authEmail"),
  authPassword: document.getElementById("authPassword"),
  authSubmit: document.getElementById("authSubmit"),
  authStatus: document.getElementById("authStatus"),
  authTabs: Array.from(document.querySelectorAll("[data-auth-mode]")),
  workspaceBadge: document.getElementById("workspaceBadge"),
  sessionCount: document.getElementById("sessionCount"),
  sessions: document.getElementById("sessions"),
  newChat: document.getElementById("newChat"),
  chatTitle: document.getElementById("chatTitle"),
  topbarSubtitle: document.getElementById("topbarSubtitle"),
  boardToggle: document.getElementById("boardToggle"),
  focusModeToggle: document.getElementById("focusModeToggle"),
  resetChat: document.getElementById("resetChat"),
  profileButton: document.getElementById("profileButton"),
  profileAvatar: document.getElementById("profileAvatar"),
  profileButtonName: document.getElementById("profileButtonName"),
  profileButtonWorkspace: document.getElementById("profileButtonWorkspace"),
  chat: document.getElementById("chat"),
  emptyState: document.getElementById("emptyState"),
  typing: document.getElementById("typing"),
  conversationSurface: document.getElementById("conversationSurface"),
  composer: document.getElementById("composer"),
  attachBtn: document.getElementById("attachBtn"),
  libraryBtn: document.getElementById("libraryBtn"),
  filePicker: document.getElementById("filePicker"),
  attachmentTray: document.getElementById("attachmentTray"),
  input: document.getElementById("message"),
  sendButton: document.getElementById("sendButton"),
  composerStatus: document.getElementById("composerStatus"),
  modeButtons: Array.from(document.querySelectorAll("[data-chat-mode]")),
  boardTitle: document.getElementById("boardTitle"),
  boardState: document.getElementById("boardState"),
  boardBody: document.getElementById("boardBody"),
  boardSources: document.getElementById("boardSources"),
  copyBoard: document.getElementById("copyBoard"),
  downloadBoard: document.getElementById("downloadBoard"),
  settingsOverlay: document.getElementById("settingsOverlay"),
  settingsPanel: document.getElementById("settingsPanel"),
  closeSettings: document.getElementById("closeSettings"),
  profileNameInput: document.getElementById("profileNameInput"),
  profileWorkspaceInput: document.getElementById("profileWorkspaceInput"),
  profileEmailText: document.getElementById("profileEmailText"),
  storageModeLabel: document.getElementById("storageModeLabel"),
  accountHint: document.getElementById("accountHint"),
  authActionButton: document.getElementById("authActionButton"),
  saveProfile: document.getElementById("saveProfile"),
  logoutButton: document.getElementById("logoutButton"),
  profileStatus: document.getElementById("profileStatus"),
  resetTheme: document.getElementById("resetTheme"),
  librarySection: document.getElementById("librarySection"),
  libraryUploadButton: document.getElementById("libraryUploadButton"),
  libraryStats: document.getElementById("libraryStats"),
  libraryList: document.getElementById("libraryList"),
  libraryHint: document.getElementById("libraryHint"),
  libraryStatus: document.getElementById("libraryStatus"),
  suggestionChips: Array.from(document.querySelectorAll("[data-prompt]"))
}

const statusTargets = {
  composer: dom.composerStatus,
  auth: dom.authStatus,
  profile: dom.profileStatus,
  library: dom.libraryStatus
}

function setActiveSession(id) {
  state.sessionId = id || ""
  sessionStorage.setItem(ACTIVE_SESSION_KEY, state.sessionId)
}

function setStatus(target, message, stateName = "neutral", fallback = "") {
  setStatusState(target, message, stateName, fallback)
}

if (window.marked) {
  window.marked.setOptions({
    breaks: true,
    gfm: true
  })
}

if (window.pdfjsLib?.GlobalWorkerOptions) {
  window.pdfjsLib.GlobalWorkerOptions.workerSrc =
    "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js"
}

bindEvents()
setComposerStatus(getDefaultStatus())
renderPendingAttachments()
syncAuthMode()
autoresizeTextarea()
boot()

async function boot() {
  try {
    await bootstrapWorkspace()
    dom.input.focus()
  } catch (error) {
    setComposerStatus(
      getErrorMessage(error, "Unable to connect to the workspace."),
      "error"
    )
  }
}

function bindEvents() {
  dom.authTabs.forEach(button => {
    button.addEventListener("click", () => {
      state.authMode = button.dataset.authMode === "login" ? "login" : "register"
      syncAuthMode()
    })
  })

  dom.authForm.addEventListener("submit", async event => {
    event.preventDefault()
    await handleAuthSubmit()
  })

  dom.closeAuthModal.addEventListener("click", () => {
    closeAuthModal()
  })

  dom.authOverlay.addEventListener("click", () => {
    closeAuthModal()
  })

  dom.newChat.addEventListener("click", async () => {
    await createNewSession()
  })

  dom.resetChat.addEventListener("click", async () => {
    await resetCurrentSession()
  })

  dom.boardToggle.addEventListener("click", () => {
    applyUiPreferences({
      ...state.preferences.ui,
      boardOpen: !state.preferences.ui.boardOpen
    }, true)
  })

  dom.focusModeToggle.addEventListener("change", () => {
    applyUiPreferences({
      ...state.preferences.ui,
      sidebarHidden: dom.focusModeToggle.checked
    }, true)
  })

  dom.profileButton.addEventListener("click", () => {
    openSettingsPanel()
  })

  dom.closeSettings.addEventListener("click", () => {
    closeSettingsPanel()
  })

  dom.settingsOverlay.addEventListener("click", () => {
    closeSettingsPanel()
  })

  dom.saveProfile.addEventListener("click", async () => {
    await saveProfile()
  })

  dom.authActionButton.addEventListener("click", () => {
    openAuthModal()
  })

  dom.logoutButton.addEventListener("click", async () => {
    await logout()
  })

  dom.attachBtn.addEventListener("click", () => {
    state.uploadTarget = "composer"
    dom.filePicker.click()
  })

  dom.libraryBtn.addEventListener("click", () => {
    openSettingsPanel("library")
  })

  dom.libraryUploadButton.addEventListener("click", () => {
    state.uploadTarget = "library"
    dom.filePicker.click()
  })

  dom.filePicker.addEventListener("change", async event => {
    const files = event.target.files

    if (files?.length) {
      if (state.uploadTarget === "library") {
        await importFilesToLibrary(files)
      } else {
        await addFilesToComposer(files)
      }
    }

    dom.filePicker.value = ""
    state.uploadTarget = "composer"
  })

  dom.composer.addEventListener("submit", async event => {
    event.preventDefault()
    await sendMessage()
  })

  dom.input.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault()
      sendMessage()
    }
  })

  dom.input.addEventListener("input", () => {
    autoresizeTextarea()
  })

  dom.modeButtons.forEach(button => {
    button.addEventListener("click", () => {
      applyUiPreferences({
        ...state.preferences.ui,
        chatMode: normalizeChatModeValue(button.dataset.chatMode)
      }, true)
    })
  })

  dom.sessions.addEventListener("click", async event => {
    const deleteButton = event.target.closest("[data-delete-session]")

    if (deleteButton) {
      event.stopPropagation()
      await deleteSession(deleteButton.dataset.deleteSession)
      return
    }

    const sessionButton = event.target.closest("[data-session-id]")

    if (!sessionButton) return

    await selectSession(sessionButton.dataset.sessionId)
  })

  dom.sessions.addEventListener("keydown", async event => {
    const sessionButton = event.target.closest("[data-session-id]")

    if (!sessionButton) return

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      await selectSession(sessionButton.dataset.sessionId)
    }
  })

  dom.attachmentTray.addEventListener("click", event => {
    const removeButton = event.target.closest("[data-remove-attachment]")

    if (!removeButton) return

    removePendingAttachment(removeButton.dataset.removeAttachment)
  })

  dom.chat.addEventListener("click", event => {
    const followupButton = event.target.closest("[data-followup]")

    if (followupButton) {
      useFollowup(followupButton.dataset.followup)
      return
    }

    const assistantCard = event.target.closest("[data-select-message]")

    if (!assistantCard) return

    selectBoardMessage(assistantCard.dataset.selectMessage)
  })

  dom.copyBoard.addEventListener("click", async () => {
    await copyBoardText()
  })

  dom.downloadBoard.addEventListener("click", () => {
    downloadBoardText()
  })

  dom.suggestionChips.forEach(button => {
    button.addEventListener("click", () => {
      const prompt = button.dataset.prompt || ""
      dom.input.value = prompt
      autoresizeTextarea()
      dom.input.focus()
    })
  })

  document.addEventListener("input", event => {
    const colorInput = event.target.closest("[data-theme-input]")

    if (!colorInput) return

    const key = colorInput.dataset.themeInput

    if (!THEME_KEYS.includes(key)) return

    applyThemeConfig({
      ...state.preferences.theme,
      [key]: colorInput.value
    }, true)
  })

  document.addEventListener("click", event => {
    const presetButton = event.target.closest("[data-theme-preset]")

    if (!presetButton) return

    const preset =
      THEME_PRESETS[presetButton.dataset.themePreset]

    if (!preset) return

    applyThemeConfig(preset, true)
  })

  dom.resetTheme.addEventListener("click", () => {
    applyThemeConfig(THEME_PRESETS.atelier, true)
  })

  ;[dom.conversationSurface, dom.composer].forEach(target => {
    target.addEventListener("dragover", event => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
    })

    target.addEventListener("drop", async event => {
      if (!hasDraggedFiles(event)) return
      event.preventDefault()
      await addFilesToComposer(event.dataTransfer.files)
    })
  })
}

async function handleAuthSubmit() {
  const payload = {
    name: dom.authName.value.trim(),
    email: dom.authEmail.value.trim(),
    password: dom.authPassword.value
  }

  if (!payload.email || !payload.password) {
    setAuthStatus("Email and password are required.", "error")
    return
  }

  try {
    setAuthStatus(
      state.authMode === "register"
        ? "Creating your workspace..."
        : "Signing you in..."
    )

    dom.authSubmit.disabled = true

    const response = await fetch(`/auth/${state.authMode}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify(payload)
    })

    if (!response.ok) {
      throw new Error(await response.text() || "Authentication failed.")
    }

    dom.authPassword.value = ""
    await bootstrapWorkspace()
    closeAuthModal()
    setProfileStatus("Workspace is now saved to your account.", "success")
  } catch (error) {
    setAuthStatus(getErrorMessage(error, "Authentication failed."), "error")
  } finally {
    dom.authSubmit.disabled = false
  }
}

async function bootstrapWorkspace() {
  const response = await fetch("/workspace/bootstrap", {
    headers: {
      "Cache-Control": "no-store"
    }
  })

  if (!response.ok) {
    throw new Error(await response.text() || "Unable to load workspace.")
  }

  const data = await response.json()

  state.user = data.user || null
  state.profile = normalizeProfile(data.profile, data.user)
  state.preferences = normalizePreferences(data.preferences)
  state.sessions = normalizeSessions(data.sessions)
  state.library = normalizeLibraryFiles(data.library)
  state.messages = []
  state.pendingAttachments = []

  renderProfile()
  applyThemeConfig(state.preferences.theme)
  applyUiPreferences(state.preferences.ui)
  renderLibrary()
  renderSessions()
  renderPendingAttachments()
  renderBoard()
  setComposerStatus(getDefaultStatus())

  if (!state.sessions.length) {
    await createNewSession()
    return
  }

  if (!state.sessions.some(session => session.id === state.sessionId)) {
    setActiveSession(state.sessions[0].id)
  }

  await loadCurrentSession()
  setAuthStatus("")
  dom.input.focus()
}

async function logout() {
  try {
    await fetch("/auth/logout", {
      method: "POST"
    })
  } finally {
    closeSettingsPanel()
    closeAuthModal()
    await bootstrapWorkspace()
    setProfileStatus("Signed out. Guest mode is active.", "success")
  }
}

async function createNewSession() {
  const data = await apiJson("/sessions/create", {
    method: "POST"
  })

  const session = normalizeSessionRecord(data.session)

  if (!session) {
    throw new Error("Unable to create a new chat.")
  }

  state.sessions.unshift(session)
  setActiveSession(session.id)

  renderSessions()
  await loadCurrentSession()
}

async function selectSession(id) {
  if (!id || id === state.sessionId) return

  setActiveSession(id)
  renderSessions()
  await loadCurrentSession()
}

async function deleteSession(id) {
  if (!id) return

  try {
    await apiJson("/sessions/delete", {
      method: "POST",
      body: JSON.stringify({
        id
      })
    })

    state.sessions = state.sessions.filter(session => session.id !== id)

    if (!state.sessions.length) {
      await createNewSession()
      return
    }

    if (state.sessionId === id) {
      setActiveSession(state.sessions[0].id)
      await loadCurrentSession()
    } else {
      renderSessions()
    }
  } catch (error) {
    setComposerStatus(
      getErrorMessage(error, "Unable to delete this chat."),
      "error"
    )
  }
}

async function resetCurrentSession() {
  if (!state.sessionId) return

  try {
    await apiJson(`/reset?session=${encodeURIComponent(state.sessionId)}`, {
      method: "POST"
    })

    updateSessionTitle(state.sessionId, "New Chat")
    state.messages = []
    state.selectedMessageId = ""
    clearConversation()
    renderBoard()
    renderSessions()
    updateTopbar()
    setComposerStatus("Current chat cleared.", "success")
  } catch (error) {
    setComposerStatus(
      getErrorMessage(error, "Unable to clear this chat."),
      "error"
    )
  }
}

async function loadCurrentSession() {
  dom.chatTitle.textContent = getCurrentSessionTitle()
  updateTopbar()
  clearConversation()
  renderPendingAttachments()
  showTyping(false)

  if (!state.sessionId) {
    return
  }

  try {
    const data = await apiJson(
      `/history?session=${encodeURIComponent(state.sessionId)}`
    )

    state.messages = Array.isArray(data.messages)
      ? data.messages.map(normalizeMessageRecord)
      : []

    dom.chat.innerHTML = ""
    state.messages.forEach(message => {
      dom.chat.appendChild(createMessageElement(message))
    })

    const latestAssistant =
      [...state.messages].reverse().find(message => message.role === "assistant")

    state.selectedMessageId = latestAssistant?.id || ""

    renderBoard()
    updateEmptyState()
    scrollConversation()
    await syncSessionTitleFromServer()
  } catch (error) {
    setComposerStatus(
      getErrorMessage(error, "Unable to load this chat."),
      "error"
    )
  }
}

async function syncSessionTitleFromServer() {
  if (!state.sessionId) return

  try {
    const data = await apiJson(
      `/meta?session=${encodeURIComponent(state.sessionId)}`
    )

    if (typeof data.title === "string" && data.title.trim()) {
      updateSessionTitle(state.sessionId, data.title.trim())
      renderSessions()
      updateTopbar()
    }
  } catch {}
}

async function sendMessage() {
  if (state.sending || !state.sessionId) return

  const message = dom.input.value.trim()

  if (!message && !state.pendingAttachments.length) {
    return
  }

  const attachments =
    state.pendingAttachments.map(cloneAttachment)

  const mode =
    normalizeChatModeValue(state.preferences.ui.chatMode)

  state.sending = true
  setSendingState(true)
  setComposerStatus("Sending...", "success")

  touchCurrentSession()

  const userMessage = normalizeMessageRecord({
    role: "user",
    content: message,
    mode,
    attachments
  })

  state.messages.push(userMessage)
  dom.chat.appendChild(createMessageElement(userMessage))

  dom.input.value = ""
  autoresizeTextarea()

  state.pendingAttachments = []
  renderPendingAttachments()
  updateEmptyState()
  showTyping(true)
  scrollConversation()

  const assistantMessage = normalizeMessageRecord({
    role: "assistant",
    content: "",
    mode,
    attachments: [],
    citations: [],
    followups: []
  })

  state.messages.push(assistantMessage)
  const assistantNode = createMessageElement(assistantMessage)
  dom.chat.appendChild(assistantNode)
  scrollConversation()

  try {
    const response = await fetch(`/chat/stream?session=${encodeURIComponent(state.sessionId)}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        message,
        mode,
        attachments
      })
    })

    if (!response.ok) {
      throw new Error(await response.text() || "Unable to send this message.")
    }

    if (!response.body) {
      throw new Error("Streaming is not available right now.")
    }

    let metaApplied = false

    await consumeStreamPayloads(response.body, parsed => {
      metaApplied =
        handleAssistantPayload(parsed, assistantMessage, assistantNode) ||
        metaApplied
    })

    if (!assistantMessage.content.trim()) {
      assistantMessage.content = "I couldn't generate a response for that request."
      updateAssistantNode(assistantNode, assistantMessage)
    }

    if (!metaApplied) {
      state.selectedMessageId = assistantMessage.id
      renderBoard()
      await syncSessionTitleFromServer()
    }

    if (attachments.length) {
      refreshLibrary().catch(() => {})
    }

    setComposerStatus(getDefaultStatus())
  } catch (error) {
    assistantNode.classList.add("error")
    assistantMessage.content = [
      "I hit an error while processing that request.",
      "",
      getErrorMessage(error)
    ].join("\n")
    assistantMessage.followups = []
    assistantMessage.citations = []
    updateAssistantNode(assistantNode, assistantMessage)

    if (!dom.input.value) {
      dom.input.value = message
      autoresizeTextarea()
    }

    state.pendingAttachments = attachments.map(cloneAttachment)
    renderPendingAttachments()

    setComposerStatus(
      getErrorMessage(error, "Unable to send this message."),
      "error"
    )
  } finally {
    showTyping(false)
    state.sending = false
    setSendingState(false)
    scrollConversation()
  }
}

function handleAssistantPayload(parsed, assistantMessage, assistantNode) {
  if (typeof parsed.response === "string") {
    assistantMessage.content += parsed.response
    syncAssistantMessage(assistantNode, assistantMessage)
    return false
  }

  if (parsed.done) {
    showTyping(false)
  }

  if (parsed.error) {
    throw new Error(parsed.error)
  }

  if (!parsed.meta) {
    return false
  }

  assistantMessage.citations = normalizeCitations(parsed.citations)
  assistantMessage.followups = normalizeFollowups(parsed.followups)
  assistantMessage.content =
    assistantMessage.content.trim() ||
    "I couldn't generate a response for that request."

  if (typeof parsed.title === "string" && parsed.title.trim()) {
    updateSessionTitle(state.sessionId, parsed.title.trim())
    renderSessions()
    updateTopbar()
  }

  state.selectedMessageId = assistantMessage.id
  syncAssistantMessage(assistantNode, assistantMessage)
  return true
}

function syncAssistantMessage(node, message) {
  updateAssistantNode(node, message)

  if (state.selectedMessageId === message.id) {
    renderBoard()
  }

  scrollConversation()
}

async function consumeStreamPayloads(stream, onPayload) {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buffer = ""

  while (true) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    buffer += decoder.decode(value, { stream: true })
    buffer = flushStreamBuffer(buffer, onPayload)
  }

  if (buffer.trim()) {
    parseStreamChunk(buffer).forEach(onPayload)
  }
}

function flushStreamBuffer(buffer, onPayload) {
  const events = buffer.split("\n\n")
  const nextBuffer = events.pop() || ""
  events.flatMap(parseStreamChunk).forEach(onPayload)
  return nextBuffer
}

function parseStreamChunk(chunk) {
  return chunk
    .split("\n")
    .filter(line => line.startsWith("data: "))
    .map(line => line.slice(6).trim())
    .filter(payload => payload && payload !== "[DONE]")
    .map(payload => {
      try {
        return JSON.parse(payload)
      } catch {
        return null
      }
    })
    .filter(Boolean)
}

function createMessageElement(message) {
  const article = document.createElement("article")
  article.className = `message ${message.role}`
  article.dataset.messageId = message.id

  const meta = document.createElement("div")
  meta.className = "message-meta"

  const label = document.createElement("span")
  label.textContent = message.role === "assistant" ? "Lyta" : "You"

  const stateText = document.createElement("span")
  const fileCount = message.attachments?.length || 0
  stateText.textContent = `${getChatModeLabel(message.mode)} · ${fileCount ? `${fileCount} file${fileCount === 1 ? "" : "s"}` : "Message"}`

  meta.append(label, stateText)

  const card = document.createElement("div")
  card.className = "message-card"

  if (message.role === "assistant") {
    card.dataset.selectMessage = message.id
  }

  const body = document.createElement("div")
  body.className = "message-body"
  renderMessageContent(body, message)

  const footer = document.createElement("div")
  footer.className = "message-footer"
  renderMessageFooter(footer, message)

  card.appendChild(body)

  if (message.attachments?.length) {
    const stack = document.createElement("div")
    stack.className = "attachment-stack"

    message.attachments.forEach(attachment => {
      stack.appendChild(createAttachmentCard(attachment))
    })

    card.appendChild(stack)
  }

  if (footer.childElementCount) {
    card.appendChild(footer)
  }

  article.append(meta, card)

  if (message.id === state.selectedMessageId) {
    article.classList.add("is-selected")
  }

  return article
}

function updateAssistantNode(node, message) {
  const body = node.querySelector(".message-body")
  const footer = node.querySelector(".message-footer") || document.createElement("div")

  renderMessageContent(body, message)
  renderMessageFooter(footer, message)

  if (!footer.parentElement && footer.childElementCount) {
    footer.className = "message-footer"
    node.querySelector(".message-card").appendChild(footer)
  }

  if (footer.parentElement && !footer.childElementCount) {
    footer.remove()
  }
}

function renderMessageContent(target, message) {
  if (message.role === "assistant") {
    target.innerHTML = renderMarkdown(message.content, "...")
    return
  }

  target.textContent = message.content || "Attached files"
}

function renderMessageFooter(target, message) {
  target.innerHTML = ""

  const tags = document.createElement("div")
  tags.className = "message-tags"

  if (message.role === "assistant") {
    tags.appendChild(createTag(`${message.citations.length} source${message.citations.length === 1 ? "" : "s"}`))
    tags.appendChild(createTag(`${message.followups.length} follow-up${message.followups.length === 1 ? "" : "s"}`))
  }

  if (message.attachments.length) {
    tags.appendChild(createTag(`${message.attachments.length} attachment${message.attachments.length === 1 ? "" : "s"}`))
  }

  if (tags.childElementCount) {
    target.appendChild(tags)
  }

  if (message.citations.length) {
    const list = document.createElement("div")
    list.className = "sources-list"

    message.citations.forEach(citation => {
      const card = document.createElement("div")
      card.className = "source-card"

      const title = document.createElement("strong")
      title.textContent = citation.label

      const meta = document.createElement("p")
      meta.textContent = `${citation.fileName} · ${citation.snippet}`

      card.append(title, meta)
      list.appendChild(card)
    })

    target.appendChild(list)
  }

  if (message.followups.length) {
    const followupList = document.createElement("div")
    followupList.className = "followup-list"

    message.followups.forEach(text => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "followup-chip"
      button.dataset.followup = text
      button.textContent = text
      followupList.appendChild(button)
    })

    target.appendChild(followupList)
  }
}

function createTag(text) {
  const tag = document.createElement("span")
  tag.className = "message-tag"
  tag.textContent = text
  return tag
}

function createAttachmentCard(attachment) {
  const card = document.createElement("div")
  card.className = "attachment-card"

  if (attachment.kind === "image" && attachment.dataUrl) {
    const preview = document.createElement("img")
    preview.className = "attachment-preview"
    preview.src = attachment.dataUrl
    preview.alt = attachment.name
    card.appendChild(preview)
  }

  const row = document.createElement("div")
  row.className = "attachment-row"

  const copy = document.createElement("div")
  copy.className = "attachment-copy"

  const title = document.createElement("p")
  title.className = "attachment-title"
  title.textContent = attachment.name

  const meta = document.createElement("div")
  meta.className = "attachment-meta"

  meta.append(
    createPill(attachment.kind === "image" ? "Image" : "Document"),
    createPill(formatMimeLabel(attachment.mimeType)),
    createPill(formatBytes(attachment.size))
  )

  copy.append(title, meta)

  const snippetText =
    attachment.summary ||
    toSingleLine(attachment.extractedText || "", 160)

  if (snippetText) {
    const snippet = document.createElement("p")
    snippet.className = "attachment-snippet"
    snippet.textContent = snippetText
    copy.appendChild(snippet)
  }

  row.appendChild(copy)
  card.appendChild(row)
  return card
}

function renderSessions() {
  dom.sessions.innerHTML = ""

  if (!state.sessions.length) {
    const empty = document.createElement("div")
    empty.className = "session"
    empty.textContent = "No chats yet."
    dom.sessions.appendChild(empty)
  }

  state.sessions.forEach(session => {
    const row = document.createElement("div")
    row.className = `session${session.id === state.sessionId ? " active" : ""}`
    row.dataset.sessionId = session.id
    row.tabIndex = 0
    row.setAttribute("role", "button")

    const copy = document.createElement("div")
    copy.className = "session-copy"

    const title = document.createElement("strong")
    title.textContent = session.title

    const meta = document.createElement("span")
    meta.textContent = formatRelativeTime(session.updatedAt)

    copy.append(title, meta)

    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "session-delete"
    remove.dataset.deleteSession = session.id
    remove.setAttribute("aria-label", `Delete ${session.title}`)
    remove.textContent = "×"

    row.append(copy, remove)
    dom.sessions.appendChild(row)
  })

  dom.sessionCount.textContent = `${state.sessions.length} thread${state.sessions.length === 1 ? "" : "s"}`
}

function renderProfile() {
  const guest = isGuestUser()

  dom.profileAvatar.textContent = getInitials(state.profile.name)
  dom.profileButtonName.textContent = state.profile.name
  dom.profileButtonWorkspace.textContent = guest
    ? "Temporary session"
    : state.profile.workspace
  dom.workspaceBadge.textContent = guest
    ? "Guest Session"
    : state.profile.workspace
  dom.profileNameInput.value = state.profile.name
  dom.profileWorkspaceInput.value = state.profile.workspace
  dom.profileEmailText.textContent = guest
    ? "Temporary session"
    : (state.profile.email || state.user?.email || "")
  dom.storageModeLabel.textContent = guest ? "Guest Mode" : "Account"
  dom.accountHint.textContent = guest
    ? "Guest chats and files are temporary until you sign in."
    : "Chats, files, and preferences are stored only inside your account."
  dom.authActionButton.hidden = !guest
  dom.saveProfile.textContent = guest ? "Save For This Session" : "Save Profile"
  dom.logoutButton.hidden = guest
  delete dom.profileStatus.dataset.state
  dom.profileStatus.textContent = guest
    ? "Guest settings last for the current session only."
    : "Profile updates apply across refreshes."
}

function renderLibrary() {
  dom.libraryList.innerHTML = ""
  dom.libraryStats.textContent = `${state.library.length} saved file${state.library.length === 1 ? "" : "s"}`
  dom.libraryHint.textContent = isGuestUser()
    ? "Files can be reused in this guest session. Sign in to keep them permanently."
    : "Upload files once and reuse them across chats."

  if (!state.library.length) {
    const empty = document.createElement("div")
    empty.className = "library-card"
    empty.textContent = isGuestUser()
      ? "No files yet. Upload PDFs, DOCX, text files, or images to use them during this guest session."
      : "No files yet. Upload PDFs, DOCX, text files, or images to build your reusable context library."
    dom.libraryList.appendChild(empty)
    return
  }

  state.library.forEach(file => {
    const card = document.createElement("article")
    card.className = "library-card"

    const header = document.createElement("div")
    header.className = "library-card-header"

    const copy = document.createElement("div")

    const title = document.createElement("strong")
    title.textContent = file.name

    const meta = document.createElement("p")
    meta.textContent = [
      file.kind === "image" ? "Image" : "Document",
      formatMimeLabel(file.mimeType),
      formatBytes(file.size),
      file.summary || formatRelativeTime(file.updatedAt)
    ].filter(Boolean).join(" · ")

    copy.append(title, meta)

    const badge = document.createElement("span")
    badge.className = "library-badge"
    badge.textContent = file.extractedText ? "Searchable" : "Stored"

    header.append(copy, badge)

    const actions = document.createElement("div")
    actions.className = "library-card-actions"

    const useButton = document.createElement("button")
    useButton.type = "button"
    useButton.className = "secondary-button"
    useButton.textContent = "Use In Chat"
    useButton.addEventListener("click", () => {
      addLibraryFileToDraft(file.libraryFileId)
      closeSettingsPanel()
    })

    const deleteButton = document.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = "secondary-button"
    deleteButton.textContent = "Delete"
    deleteButton.addEventListener("click", async () => {
      await deleteLibraryFile(file.libraryFileId)
    })

    actions.append(useButton, deleteButton)
    card.append(header, actions)
    dom.libraryList.appendChild(card)
  })
}

function renderPendingAttachments() {
  dom.attachmentTray.innerHTML = ""

  state.pendingAttachments.forEach(attachment => {
    const card = document.createElement("div")
    card.className = "attachment-card"

    const row = document.createElement("div")
    row.className = "attachment-row"

    const main = document.createElement("div")
    main.className = "attachment-draft-main"

    if (attachment.kind === "image" && attachment.dataUrl) {
      const image = document.createElement("img")
      image.className = "attachment-thumb"
      image.src = attachment.dataUrl
      image.alt = attachment.name
      main.appendChild(image)
    } else {
      const icon = document.createElement("div")
      icon.className = "attachment-icon"
      icon.textContent = "DOC"
      main.appendChild(icon)
    }

    const copy = document.createElement("div")
    copy.className = "attachment-copy"

    const title = document.createElement("p")
    title.className = "attachment-title"
    title.textContent = attachment.name

    const meta = document.createElement("div")
    meta.className = "attachment-meta"
    meta.append(
      createPill(attachment.kind === "image" ? "Image" : "Document"),
      createPill(formatMimeLabel(attachment.mimeType)),
      createPill(formatBytes(attachment.size))
    )

    copy.append(title, meta)

    if (attachment.summary) {
      const snippet = document.createElement("p")
      snippet.className = "attachment-snippet"
      snippet.textContent = attachment.summary
      copy.appendChild(snippet)
    }

    main.appendChild(copy)

    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "attachment-remove"
    remove.dataset.removeAttachment = attachment.id
    remove.setAttribute("aria-label", `Remove ${attachment.name}`)
    remove.textContent = "×"

    row.append(main, remove)
    card.appendChild(row)
    dom.attachmentTray.appendChild(card)
  })
}

function renderBoard() {
  syncSelectedMessageStyles()

  const message = getSelectedAssistantMessage()

  if (!message) {
    dom.boardTitle.textContent = "Select a response"
    dom.boardState.hidden = false
    dom.boardBody.hidden = true
    dom.boardSources.hidden = true
    dom.boardBody.innerHTML = ""
    dom.boardSources.innerHTML = ""
    return
  }

  dom.boardTitle.textContent = deriveBoardTitle(message)
  dom.boardState.hidden = true
  dom.boardBody.hidden = false
  dom.boardBody.innerHTML = renderMarkdown(message.content)

  renderBoardSources(message.citations)
}

function renderBoardSources(citations) {
  dom.boardSources.innerHTML = ""

  if (!citations.length) {
    dom.boardSources.hidden = true
    return
  }

  dom.boardSources.hidden = false

  citations.forEach(citation => {
    const card = document.createElement("div")
    card.className = "board-source"

    const copy = document.createElement("div")
    copy.className = "board-source-copy"

    const title = document.createElement("strong")
    title.textContent = `${citation.label} · ${citation.fileName}`

    const snippet = document.createElement("p")
    snippet.textContent = citation.snippet

    copy.append(title, snippet)
    card.appendChild(copy)
    dom.boardSources.appendChild(card)
  })
}

function openSettingsPanel(section) {
  dom.settingsOverlay.hidden = false
  document.body.classList.add("settings-open")
  dom.settingsPanel.setAttribute("aria-hidden", "false")

  if (section === "library") {
    dom.librarySection.scrollIntoView({
      behavior: "smooth",
      block: "start"
    })
  }
}

function closeSettingsPanel() {
  document.body.classList.remove("settings-open")
  dom.settingsPanel.setAttribute("aria-hidden", "true")
  dom.settingsOverlay.hidden = true
}

function openAuthModal() {
  closeSettingsPanel()
  dom.authOverlay.hidden = false
  dom.authModal.hidden = false
  dom.authModal.setAttribute("aria-hidden", "false")
  setAuthStatus("")
  ;(state.authMode === "register" ? dom.authName : dom.authEmail).focus()
}

function closeAuthModal() {
  dom.authOverlay.hidden = true
  dom.authModal.hidden = true
  dom.authModal.setAttribute("aria-hidden", "true")
}

async function saveProfile() {
  const payload = {
    name: dom.profileNameInput.value.trim(),
    workspace: dom.profileWorkspaceInput.value.trim()
  }

  try {
    const data = await apiJson("/workspace/profile", {
      method: "POST",
      body: JSON.stringify(payload)
    })

    state.profile = normalizeProfile(data.profile, state.user)
    renderProfile()
    setProfileStatus("Profile saved.", "success")
    updateTopbar()
  } catch (error) {
    setProfileStatus(
      getErrorMessage(error, "Unable to save the profile."),
      "error"
    )
  }
}

async function addFilesToComposer(fileList) {
  const files = Array.from(fileList || [])

  if (!files.length) return

  const remaining = MAX_ATTACHMENTS - state.pendingAttachments.length

  if (remaining <= 0) {
    setComposerStatus("You can attach up to 4 files.", "warning")
    return
  }

  const selected = files.slice(0, remaining)

  if (files.length > selected.length) {
    setComposerStatus("Only the first 4 files were added.", "warning")
  }

  for (const file of selected) {
    try {
      setComposerStatus(`Preparing ${file.name}...`)
      const attachment = await prepareAttachment(file)
      state.pendingAttachments.push(attachment)
      renderPendingAttachments()
    } catch (error) {
      setComposerStatus(
        getErrorMessage(error, `Couldn't prepare ${file.name}.`),
        "error"
      )
    }
  }

  if (state.pendingAttachments.length) {
    setComposerStatus(
      `${state.pendingAttachments.length} file${state.pendingAttachments.length === 1 ? "" : "s"} ready.`,
      "success"
    )
  } else {
    setComposerStatus(getDefaultStatus())
  }
}

async function importFilesToLibrary(fileList) {
  const files = Array.from(fileList || [])

  if (!files.length) return

  try {
    setLibraryStatus("Preparing files...")

    const attachments = []

    for (const file of files) {
      attachments.push(await prepareAttachment(file))
    }

    const data = await apiJson("/library/import", {
      method: "POST",
      body: JSON.stringify({
        attachments
      })
    })

    if (Array.isArray(data.files)) {
      await refreshLibrary()
      setLibraryStatus(
        `${data.files.length} file${data.files.length === 1 ? "" : "s"} added to your library.`,
        "success"
      )
    }
  } catch (error) {
    setLibraryStatus(
      getErrorMessage(error, "Unable to add files to the library."),
      "error"
    )
  }
}

async function refreshLibrary() {
  const data = await apiJson("/library")
  state.library = normalizeLibraryFiles(data.files)
  renderLibrary()
  updateTopbar()
}

async function deleteLibraryFile(id) {
  try {
    await apiJson("/library/delete", {
      method: "POST",
      body: JSON.stringify({
        id
      })
    })

    state.library = state.library.filter(file => file.libraryFileId !== id)
    state.pendingAttachments = state.pendingAttachments.filter(
      attachment => attachment.libraryFileId !== id
    )
    renderLibrary()
    renderPendingAttachments()
    setLibraryStatus("File removed from your library.", "success")
    setComposerStatus(getDefaultStatus())
    updateTopbar()
  } catch (error) {
    setLibraryStatus(
      getErrorMessage(error, "Unable to delete this file."),
      "error"
    )
  }
}

function addLibraryFileToDraft(id) {
  const file = state.library.find(item => item.libraryFileId === id)

  if (!file) return

  if (state.pendingAttachments.length >= MAX_ATTACHMENTS) {
    setComposerStatus("You can attach up to 4 files.", "warning")
    return
  }

  if (state.pendingAttachments.some(item => item.libraryFileId === id)) {
    setComposerStatus("That file is already attached.", "warning")
    return
  }

  state.pendingAttachments.push({
    id: crypto.randomUUID(),
    libraryFileId: file.libraryFileId,
    kind: file.kind,
    name: file.name,
    mimeType: file.mimeType,
    size: file.size,
    summary: file.summary,
    dataUrl: file.dataUrl,
    extractedText: file.extractedText
  })

  renderPendingAttachments()
  setComposerStatus(
    `${file.name} added from your library.`,
    "success"
  )
}

function removePendingAttachment(id) {
  state.pendingAttachments =
    state.pendingAttachments.filter(attachment => attachment.id !== id)

  renderPendingAttachments()

  if (state.pendingAttachments.length) {
    setComposerStatus(
      `${state.pendingAttachments.length} file${state.pendingAttachments.length === 1 ? "" : "s"} ready.`,
      "success"
    )
  } else {
    setComposerStatus(getDefaultStatus())
  }
}

function useFollowup(text) {
  dom.input.value = text || ""
  autoresizeTextarea()
  dom.input.focus()
}

function selectBoardMessage(id) {
  if (!id) return
  state.selectedMessageId = id
  renderBoard()
}

async function copyBoardText() {
  const message = getSelectedAssistantMessage()

  if (!message) return

  await navigator.clipboard.writeText(message.content)
  setComposerStatus("Board content copied.", "success")
}

function downloadBoardText() {
  const message = getSelectedAssistantMessage()

  if (!message) return

  const blob = new Blob([message.content], {
    type: "text/markdown;charset=utf-8"
  })

  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = `${slugify(deriveBoardTitle(message)) || "lyta-output"}.md`
  anchor.click()
  URL.revokeObjectURL(url)
}

function clearConversation() {
  dom.chat.innerHTML = ""
  updateEmptyState()
}

function updateEmptyState() {
  dom.emptyState.hidden = dom.chat.childElementCount > 0
}

function updateTopbar() {
  dom.chatTitle.textContent = getCurrentSessionTitle()
  const scope = isGuestUser()
    ? "Guest session"
    : "Account workspace"

  dom.topbarSubtitle.textContent = `${scope} · ${state.library.length} library file${state.library.length === 1 ? "" : "s"} · ${state.sessions.length} chat${state.sessions.length === 1 ? "" : "s"}`
}

function applyThemeConfig(theme, persist = false) {
  const { theme: nextTheme, styles } = buildThemeStyles(theme)
  state.preferences.theme = nextTheme

  Object.entries(styles).forEach(([name, value]) => {
    document.documentElement.style.setProperty(name, value)
  })

  syncThemeControls()
  syncPresetState()

  if (persist) {
    schedulePreferenceSave()
  }
}

function applyUiPreferences(ui, persist = false) {
  state.preferences.ui = {
    sidebarHidden: Boolean(ui?.sidebarHidden),
    boardOpen: ui?.boardOpen !== false,
    chatMode: normalizeChatModeValue(ui?.chatMode)
  }

  document.body.classList.toggle("sidebar-hidden", state.preferences.ui.sidebarHidden)
  document.body.classList.toggle("board-closed", !state.preferences.ui.boardOpen)
  dom.focusModeToggle.checked = state.preferences.ui.sidebarHidden
  dom.boardToggle.textContent = state.preferences.ui.boardOpen ? "Board" : "Show Board"
  syncModeButtons()

  if (persist) {
    schedulePreferenceSave()
  }
}

function schedulePreferenceSave() {
  window.clearTimeout(state.preferenceTimer)
  state.preferenceTimer = window.setTimeout(() => {
    persistPreferences().catch(() => {})
  }, 260)
}

async function persistPreferences() {
  await apiJson("/workspace/preferences", {
    method: "POST",
    body: JSON.stringify({
      theme: state.preferences.theme,
      ui: state.preferences.ui
    })
  })
}

function syncModeButtons() {
  dom.modeButtons.forEach(button => {
    button.classList.toggle(
      "is-active",
      normalizeChatModeValue(button.dataset.chatMode) === state.preferences.ui.chatMode
    )
  })
}

function syncThemeControls() {
  document.querySelectorAll("[data-theme-input]").forEach(inputEl => {
    const key = inputEl.dataset.themeInput

    if (THEME_KEYS.includes(key)) {
      inputEl.value = state.preferences.theme[key]
    }
  })
}

function syncPresetState() {
  document.querySelectorAll("[data-theme-preset]").forEach(button => {
    const preset = THEME_PRESETS[button.dataset.themePreset]
    const isActive = THEME_KEYS.every(key => preset?.[key] === state.preferences.theme[key])
    button.classList.toggle("is-active", isActive)
  })
}

function syncAuthMode() {
  const isRegister = state.authMode === "register"

  dom.authTabs.forEach(button => {
    button.classList.toggle(
      "is-active",
      button.dataset.authMode === state.authMode
    )
  })

  dom.authNameField.hidden = !isRegister
  dom.authSubmit.textContent = isRegister ? "Create Workspace" : "Sign In"
  dom.authPassword.autocomplete = isRegister ? "new-password" : "current-password"
}

function isGuestUser() {
  return Boolean(state.user?.isGuest)
}

function getDefaultStatus() {
  return isGuestUser()
    ? "Guest uploads stay available for this session only."
    : "Uploads sync into your account library automatically."
}

function setSendingState(active) {
  dom.sendButton.disabled = active
  dom.attachBtn.disabled = active
  dom.libraryBtn.disabled = active
}

function setComposerStatus(message, stateName = "neutral") {
  setStatus(statusTargets.composer, message, stateName, getDefaultStatus())
}

function setAuthStatus(message, stateName = "neutral") {
  setStatus(statusTargets.auth, message, stateName)
}

function setProfileStatus(message, stateName = "neutral") {
  setStatus(statusTargets.profile, message, stateName)
}

function setLibraryStatus(message, stateName = "neutral") {
  setStatus(statusTargets.library, message, stateName)
}

function showTyping(visible) {
  dom.typing.hidden = !visible
}

function scrollConversation() {
  requestAnimationFrame(() => {
    dom.conversationSurface.scrollTop = dom.conversationSurface.scrollHeight
  })
}

function autoresizeTextarea() {
  dom.input.style.height = "0px"
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 220)}px`
}

function createPill(text) {
  const pill = document.createElement("span")
  pill.className = "attachment-pill"
  pill.textContent = text
  return pill
}

function getCurrentSessionTitle() {
  return state.sessions.find(session => session.id === state.sessionId)?.title || "New Chat"
}

function updateSessionTitle(id, title) {
  const session = state.sessions.find(item => item.id === id)

  if (!session) return

  session.title = (title || "New Chat").trim().slice(0, 60)
  session.updatedAt = new Date().toISOString()
}

function touchCurrentSession() {
  const session = state.sessions.find(item => item.id === state.sessionId)

  if (!session) return

  session.updatedAt = new Date().toISOString()
  state.sessions.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
  renderSessions()
  updateTopbar()
}

function getSelectedAssistantMessage() {
  return state.messages.find(message => {
    return message.id === state.selectedMessageId && message.role === "assistant"
  }) || [...state.messages].reverse().find(message => message.role === "assistant") || null
}

function syncSelectedMessageStyles() {
  dom.chat.querySelectorAll(".message.assistant").forEach(node => {
    node.classList.toggle(
      "is-selected",
      node.dataset.messageId === state.selectedMessageId
    )
  })
}

function deriveBoardTitle(message) {
  const heading =
    message.content.match(/^#+\s+(.+)$/m)?.[1] ||
    message.content.split("\n").find(line => line.trim()) ||
    getCurrentSessionTitle()

  return heading.trim().slice(0, 60) || "Selected Output"
}
