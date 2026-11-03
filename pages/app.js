const {
  MAX_ATTACHMENTS,
  ACTIVE_SESSION_KEY,
  THEME_MODE_KEY,
  DEFAULT_PROFILE,
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
  normalizeThemeMode,
  resolveThemeMode,
  toSingleLine,
  formatMimeLabel,
  formatBytes,
  formatRelativeTime,
  renderMarkdown,
  getFileTypeGlyph,
  setStatusState,
  getInitials,
  hasDraggedFiles,
  getErrorMessage,
  cloneAttachment,
  clonePreferences,
  slugify,
  apiJson,
  extractResponseErrorMessage,
  announce
} = window.LytaCore

const { prepareAttachment } = window.LytaAttachments

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

const state = {
  user: null,
  profile: { ...DEFAULT_PROFILE },
  preferences: clonePreferences(DEFAULT_PREFERENCES),
  themeMode: "system",
  sessions: [],
  sessionId: sessionStorage.getItem(ACTIVE_SESSION_KEY) || "",
  sessionFilterText: "",
  messages: [],
  library: [],
  pendingAttachments: [],
  selectedMessageId: "",
  sending: false,
  activeAbortController: null,
  authMode: "register",
  uploadTarget: "composer",
  preferenceTimer: null,
  lastFocusedBeforeOverlay: null
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
  sidebar: document.getElementById("sidebar"),
  sidebarBackdrop: document.getElementById("sidebarBackdrop"),
  sidebarCollapseToggle: document.getElementById("sidebarCollapseToggle"),
  sidebarMenuToggle: document.getElementById("sidebarMenuToggle"),
  workspaceBadge: document.getElementById("workspaceBadge"),
  workspaceName: document.getElementById("workspaceName"),
  workspaceSummary: document.getElementById("workspaceSummary"),
  sidebarAddFile: document.getElementById("sidebarAddFile"),
  sidebarLibrary: document.getElementById("sidebarLibrary"),
  sessionFilter: document.getElementById("sessionFilter"),
  sessionCount: document.getElementById("sessionCount"),
  sessions: document.getElementById("sessions"),
  newChat: document.getElementById("newChat"),
  chatTitle: document.getElementById("chatTitle"),
  boardToggle: document.getElementById("boardToggle"),
  resetChat: document.getElementById("resetChat"),
  chatModeButtons: Array.from(document.querySelectorAll('[data-chat-mode]')),
  themeModeButtons: Array.from(document.querySelectorAll('[data-theme-mode]')),
  profileButton: document.getElementById("profileButton"),
  profileAvatar: document.getElementById("profileAvatar"),
  profileMenu: document.getElementById("profileMenu"),
  profileMenuName: document.getElementById("profileMenuName"),
  profileMenuWorkspace: document.getElementById("profileMenuWorkspace"),
  menuAuthAction: document.getElementById("menuAuthAction"),
  menuLogoutAction: document.getElementById("menuLogoutAction"),
  topbarOverflowToggle: document.getElementById("topbarOverflowToggle"),
  topbarOverflowMenu: document.getElementById("topbarOverflowMenu"),
  chat: document.getElementById("chat"),
  emptyState: document.getElementById("emptyState"),
  conversationSurface: document.getElementById("conversationSurface"),
  composer: document.getElementById("composer"),
  attachBtn: document.getElementById("attachBtn"),
  libraryBtn: document.getElementById("libraryBtn"),
  filePicker: document.getElementById("filePicker"),
  attachmentTray: document.getElementById("attachmentTray"),
  input: document.getElementById("message"),
  sendButton: document.getElementById("sendButton"),
  composerStatus: document.getElementById("composerStatus"),
  boardBackdrop: document.getElementById("boardBackdrop"),
  boardTitle: document.getElementById("boardTitle"),
  boardMeta: document.getElementById("boardMeta"),
  boardState: document.getElementById("boardState"),
  boardBody: document.getElementById("boardBody"),
  boardSources: document.getElementById("boardSources"),
  boardClose: document.getElementById("boardClose"),
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
  librarySection: document.getElementById("librarySection"),
  libraryUploadButton: document.getElementById("libraryUploadButton"),
  libraryStats: document.getElementById("libraryStats"),
  libraryList: document.getElementById("libraryList"),
  libraryHint: document.getElementById("libraryHint"),
  libraryStatus: document.getElementById("libraryStatus"),
  suggestionChips: Array.from(document.querySelectorAll("[data-prompt]")),
  shortcutsOverlay: document.getElementById("shortcutsOverlay"),
  shortcutsSheet: document.getElementById("shortcutsSheet"),
  closeShortcuts: document.getElementById("closeShortcuts")
}

const statusTargets = {
  composer: dom.composerStatus,
  auth: dom.authStatus,
  profile: dom.profileStatus,
  library: dom.libraryStatus
}

/* -------------------------------------------------------------------- */
/* menu + overlay primitives                                            */
/* -------------------------------------------------------------------- */

const menus = []

function createMenu(trigger, menu) {
  const controller = {
    trigger,
    menu,
    isOpen: () => !menu.hidden,
    open() {
      menus.forEach(other => other !== controller && other.close({ restoreFocus: false }))
      menu.hidden = false
      trigger.setAttribute("aria-expanded", "true")
      const target = menu.querySelector('[role^="menuitem"]')
      target?.focus()
    },
    close({ restoreFocus = true } = {}) {
      if (menu.hidden) return
      menu.hidden = true
      trigger.setAttribute("aria-expanded", "false")
      if (restoreFocus) trigger.focus()
    }
  }

  trigger.addEventListener("click", () => {
    controller.isOpen() ? controller.close() : controller.open()
  })

  menus.push(controller)
  return controller
}

const profileMenuCtl = createMenu(dom.profileButton, dom.profileMenu)
const overflowMenuCtl = createMenu(dom.topbarOverflowToggle, dom.topbarOverflowMenu)

document.addEventListener("click", event => {
  menus.forEach(controller => {
    if (!controller.isOpen()) return
    if (controller.menu.contains(event.target) || controller.trigger.contains(event.target)) return
    controller.close({ restoreFocus: false })
  })
})

function trapFocus(container) {
  function getFocusable() {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(
      el => el.offsetParent !== null
    )
  }

  function handleKeydown(event) {
    if (event.key !== "Tab") return
    const focusable = getFocusable()
    if (!focusable.length) return
    const first = focusable[0]
    const last = focusable[focusable.length - 1]

    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first.focus()
    }
  }

  container.addEventListener("keydown", handleKeydown)
  return () => container.removeEventListener("keydown", handleKeydown)
}

function showOverlay(el) {
  el.hidden = false
  requestAnimationFrame(() => el.classList.add("is-visible"))
}

function hideOverlay(el) {
  el.classList.remove("is-visible")
  window.setTimeout(() => {
    el.hidden = true
  }, 200)
}

let settingsFocusRelease = null
let authFocusRelease = null
let shortcutsFocusRelease = null

function setActiveSession(id) {
  state.sessionId = id || ""
  sessionStorage.setItem(ACTIVE_SESSION_KEY, state.sessionId)
}

function setStatus(target, message, stateName = "neutral", fallback = "") {
  setStatusState(target, message, stateName, fallback)
}

initThemeMode()
bindEvents()
setComposerStatus(getDefaultStatus())
renderPendingAttachments()
syncAuthMode()
autoresizeTextarea()
boot()

async function boot() {
  try {
    await bootstrapWorkspace()
    focusComposerIfWide()
  } catch (error) {
    setComposerStatus(
      getErrorMessage(error, "Unable to connect to the workspace."),
      "error"
    )
  }
}

/* -------------------------------------------------------------------- */
/* theme mode                                                           */
/* -------------------------------------------------------------------- */

function initThemeMode() {
  let stored = "system"

  try {
    stored = normalizeThemeMode(localStorage.getItem(THEME_MODE_KEY))
  } catch {}

  applyThemeMode(stored, false)

  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (state.themeMode === "system") {
      applyThemeMode("system", false)
    }
  })
}

function applyThemeMode(mode, persist) {
  const normalized = normalizeThemeMode(mode)
  state.themeMode = normalized
  const resolved = resolveThemeMode(normalized)

  document.documentElement.dataset.themeMode = normalized
  document.documentElement.dataset.theme = resolved

  dom.themeModeButtons.forEach(button => {
    button.setAttribute(
      "aria-pressed",
      button.dataset.themeMode === normalized ? "true" : "false"
    )
  })

  if (persist) {
    try {
      localStorage.setItem(THEME_MODE_KEY, normalized)
    } catch {}
  }
}

/* -------------------------------------------------------------------- */
/* event binding                                                        */
/* -------------------------------------------------------------------- */

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

  dom.closeAuthModal.addEventListener("click", () => closeAuthModal())
  dom.authOverlay.addEventListener("click", () => closeAuthModal())

  dom.newChat.addEventListener("click", async () => {
    await createNewSession()
    closeMobileSidebar()
  })

  dom.resetChat.addEventListener("click", async () => {
    await resetCurrentSession()
  })

  dom.boardToggle.addEventListener("click", () => {
    toggleBoard()
  })

  dom.boardClose.addEventListener("click", () => {
    closeMobileBoard()
    applyUiPreferences({ ...state.preferences.ui, boardOpen: false }, true)
  })

  dom.boardBackdrop.addEventListener("click", () => closeMobileBoard())

  dom.sidebarCollapseToggle.addEventListener("click", () => {
    applyUiPreferences(
      { ...state.preferences.ui, sidebarHidden: !state.preferences.ui.sidebarHidden },
      true
    )
  })

  dom.sidebarMenuToggle.addEventListener("click", () => openMobileSidebar())
  dom.sidebarBackdrop.addEventListener("click", () => closeMobileSidebar())

  dom.profileButton.addEventListener("click", () => {
    syncProfileMenu()
  })

  dom.profileMenu.addEventListener("click", event => {
    const item = event.target.closest("[data-action]")
    if (!item) return

    profileMenuCtl.close({ restoreFocus: false })

    switch (item.dataset.action) {
      case "open-settings":
        openSettingsPanel(undefined, dom.profileButton)
        break
      case "open-shortcuts":
        openShortcuts(dom.profileButton)
        break
      case "open-auth":
        openAuthModal(dom.profileButton)
        break
      case "logout":
        logout()
        break
    }
  })

  dom.topbarOverflowMenu.addEventListener("click", event => {
    const modeItem = event.target.closest("[data-chat-mode]")

    if (modeItem) {
      applyUiPreferences(
        { ...state.preferences.ui, chatMode: normalizeChatModeValue(modeItem.dataset.chatMode) },
        true
      )
      overflowMenuCtl.close({ restoreFocus: false })
      return
    }

    const actionItem = event.target.closest("[data-action]")
    if (!actionItem) return

    overflowMenuCtl.close({ restoreFocus: false })

    if (actionItem.dataset.action === "toggle-board") toggleBoard()
    if (actionItem.dataset.action === "clear-chat") resetCurrentSession()
  })

  dom.closeSettings.addEventListener("click", () => closeSettingsPanel())
  dom.settingsOverlay.addEventListener("click", () => closeSettingsPanel())

  dom.themeModeButtons.forEach(button => {
    button.addEventListener("click", () => {
      applyThemeMode(button.dataset.themeMode, true)
    })
  })

  dom.saveProfile.addEventListener("click", async () => {
    await saveProfile()
  })

  dom.authActionButton.addEventListener("click", () => openAuthModal())
  dom.logoutButton.addEventListener("click", async () => await logout())

  dom.closeShortcuts.addEventListener("click", () => closeShortcuts())
  dom.shortcutsOverlay.addEventListener("click", () => closeShortcuts())

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

  dom.sidebarAddFile.addEventListener("click", () => {
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
      if (!state.sending) sendMessage()
    }
  })

  dom.input.addEventListener("input", () => {
    autoresizeTextarea()
    syncSendButtonState()
  })

  dom.chatModeButtons.forEach(button => {
    button.addEventListener("click", () => {
      applyUiPreferences({
        ...state.preferences.ui,
        chatMode: normalizeChatModeValue(button.dataset.chatMode)
      }, true)
    })
  })

  dom.sessionFilter.addEventListener("input", () => {
    state.sessionFilterText = dom.sessionFilter.value.trim().toLowerCase()
    renderSessions()
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
    closeMobileSidebar()
  })

  dom.sessions.addEventListener("keydown", async event => {
    const sessionButton = event.target.closest("[data-session-id]")
    if (!sessionButton) return

    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault()
      await selectSession(sessionButton.dataset.sessionId)
      closeMobileSidebar()
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

    const copyButton = event.target.closest("[data-copy-message]")
    if (copyButton) {
      copyMessageContent(copyButton.dataset.copyMessage)
      return
    }

    const pinButton = event.target.closest("[data-pin-message]")
    if (pinButton) {
      selectBoardMessage(pinButton.dataset.pinMessage)
      return
    }

    handleCitationClick(event, dom.chat)
  })

  dom.chat.addEventListener("mouseover", event => handleCitationHover(event, true))
  dom.chat.addEventListener("mouseout", event => handleCitationHover(event, false))
  dom.chat.addEventListener("focusin", event => handleCitationHover(event, true))
  dom.chat.addEventListener("focusout", event => handleCitationHover(event, false))

  dom.boardBody.addEventListener("click", event => handleCitationClick(event, dom.boardBody))
  dom.boardBody.addEventListener("mouseover", event => handleCitationHover(event, true))
  dom.boardBody.addEventListener("mouseout", event => handleCitationHover(event, false))

  dom.copyBoard.addEventListener("click", async () => await copyBoardText())
  dom.downloadBoard.addEventListener("click", () => downloadBoardText())

  dom.suggestionChips.forEach(button => {
    button.addEventListener("click", () => {
      const prompt = button.dataset.prompt || ""
      dom.input.value = prompt
      autoresizeTextarea()
      syncSendButtonState()
      dom.input.focus()
    })
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

  document.addEventListener("keydown", handleGlobalKeydown)
}

function handleGlobalKeydown(event) {
  const mod = event.metaKey || event.ctrlKey

  if (mod && event.key.toLowerCase() === "k") {
    event.preventDefault()
    openMobileSidebarIfNeeded()
    dom.sessionFilter.focus()
    return
  }

  if (mod && event.key === "Enter") {
    event.preventDefault()
    if (state.sending) {
      stopActiveStream()
    } else {
      sendMessage()
    }
    return
  }

  if (mod && event.key === "/") {
    event.preventDefault()
    dom.shortcutsSheet.hidden ? openShortcuts() : closeShortcuts()
    return
  }

  if (mod && event.key.toLowerCase() === "b") {
    event.preventDefault()
    toggleSidebar()
    return
  }

  if (event.key === "Escape") {
    closeTopLayer()
  }
}

function openMobileSidebarIfNeeded() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    openMobileSidebar()
  } else if (state.preferences.ui.sidebarHidden) {
    applyUiPreferences({ ...state.preferences.ui, sidebarHidden: false }, true)
  }
}

function toggleSidebar() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    document.body.classList.contains("sidebar-mobile-open")
      ? closeMobileSidebar()
      : openMobileSidebar()
    return
  }

  applyUiPreferences(
    { ...state.preferences.ui, sidebarHidden: !state.preferences.ui.sidebarHidden },
    true
  )
}

function closeTopLayer() {
  if (!dom.shortcutsSheet.hidden) return closeShortcuts()
  if (!dom.authModal.hidden) return closeAuthModal()
  if (document.body.classList.contains("settings-open")) return closeSettingsPanel()
  if (menus.some(controller => controller.isOpen())) {
    menus.forEach(controller => controller.close({ restoreFocus: false }))
    return
  }
  if (document.body.classList.contains("board-sheet-open")) return closeMobileBoard()
  if (document.body.classList.contains("sidebar-mobile-open")) return closeMobileSidebar()
}

/* -------------------------------------------------------------------- */
/* mobile sidebar / board sheets                                        */
/* -------------------------------------------------------------------- */

function openMobileSidebar() {
  document.body.classList.add("sidebar-mobile-open")
  showOverlay(dom.sidebarBackdrop)
  dom.sidebar.querySelector(FOCUSABLE_SELECTOR)?.focus()
}

function closeMobileSidebar() {
  if (!document.body.classList.contains("sidebar-mobile-open")) return
  document.body.classList.remove("sidebar-mobile-open")
  hideOverlay(dom.sidebarBackdrop)
}

function openMobileBoard() {
  document.body.classList.add("board-sheet-open")
  showOverlay(dom.boardBackdrop)
}

function closeMobileBoard() {
  if (!document.body.classList.contains("board-sheet-open")) return
  document.body.classList.remove("board-sheet-open")
  hideOverlay(dom.boardBackdrop)
}

function toggleBoard() {
  if (window.matchMedia("(max-width: 980px)").matches) {
    document.body.classList.contains("board-sheet-open")
      ? closeMobileBoard()
      : openMobileBoard()
    return
  }

  applyUiPreferences({
    ...state.preferences.ui,
    boardOpen: !state.preferences.ui.boardOpen
  }, true)
}

/* -------------------------------------------------------------------- */
/* auth                                                                  */
/* -------------------------------------------------------------------- */

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
      throw new Error(await extractResponseErrorMessage(response, "Authentication failed."))
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
    throw new Error(await extractResponseErrorMessage(response, "Unable to load workspace."))
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
  applyUiPreferences(state.preferences.ui)
  renderLibrary()
  renderSessions()
  renderPendingAttachments()
  renderBoard()
  setComposerStatus(getDefaultStatus())
  // The guest cookie exists from here on, so app-review.js can load reviews
  // without racing this request into a second guest workspace.
  document.dispatchEvent(new CustomEvent("lyta:workspace-ready"))

  if (!state.sessions.length) {
    await createNewSession()
    return
  }

  if (!state.sessions.some(session => session.id === state.sessionId)) {
    setActiveSession(state.sessions[0].id)
  }

  await loadCurrentSession()
  setAuthStatus("")
  focusComposerIfWide()
}

function focusComposerIfWide() {
  if (window.matchMedia("(min-width: 760px)").matches) {
    dom.input.focus()
  }
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

/* -------------------------------------------------------------------- */
/* sessions                                                              */
/* -------------------------------------------------------------------- */

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

/* -------------------------------------------------------------------- */
/* messaging                                                             */
/* -------------------------------------------------------------------- */

async function sendMessage() {
  if (state.sending) {
    stopActiveStream()
    return
  }

  if (!state.sessionId) return

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
  announce("LYTA is responding.")

  touchCurrentSession()

  const userMessage = normalizeMessageRecord({
    role: "user",
    content: message,
    mode,
    attachments,
    createdAt: new Date().toISOString()
  })

  state.messages.push(userMessage)
  dom.chat.appendChild(createMessageElement(userMessage))

  dom.input.value = ""
  autoresizeTextarea()

  state.pendingAttachments = []
  renderPendingAttachments()
  updateEmptyState()
  scrollConversation()

  const assistantMessage = normalizeMessageRecord({
    role: "assistant",
    content: "",
    mode,
    attachments: [],
    citations: [],
    followups: [],
    createdAt: new Date().toISOString()
  })

  state.messages.push(assistantMessage)
  const assistantNode = createMessageElement(assistantMessage, { streaming: true })
  dom.chat.appendChild(assistantNode)
  scrollConversation()

  const controller = new AbortController()
  state.activeAbortController = controller

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
      }),
      signal: controller.signal
    })

    if (!response.ok) {
      throw new Error(await readChatFailureMessage(response))
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
    }

    updateAssistantNode(assistantNode, assistantMessage, { streaming: false })

    if (!metaApplied) {
      state.selectedMessageId = assistantMessage.id
      renderBoard()
      await syncSessionTitleFromServer()
    }

    if (attachments.length) {
      refreshLibrary().catch(() => {})
    }

    setComposerStatus(getDefaultStatus())
    announce(assistantMessage.citations.length ? `Response complete with ${assistantMessage.citations.length} cited sources.` : "Response complete.")
  } catch (error) {
    const aborted = error?.name === "AbortError"

    if (aborted) {
      assistantMessage.content = assistantMessage.content.trim() || "Generation stopped."
      updateAssistantNode(assistantNode, assistantMessage, { streaming: false })
      setComposerStatus("Generation stopped.", "warning")
    } else {
      assistantNode.classList.add("error")
      assistantMessage.content = [
        "I hit an error while processing that request.",
        "",
        getErrorMessage(error)
      ].join("\n")
      assistantMessage.followups = []
      assistantMessage.citations = []
      updateAssistantNode(assistantNode, assistantMessage, { streaming: false })

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
      announce("The response failed. Your message is back in the composer.", "assertive")
    }
  } finally {
    state.activeAbortController = null
    state.sending = false
    setSendingState(false)
    scrollConversation()
  }
}

function stopActiveStream() {
  state.activeAbortController?.abort()
}

async function readChatFailureMessage(response) {
  return extractResponseErrorMessage(
    response,
    "LYTA server error. Please retry; request failed before streaming started."
  )
}

function handleAssistantPayload(parsed, assistantMessage, assistantNode) {
  if (typeof parsed.response === "string") {
    assistantMessage.content += parsed.response
    syncAssistantMessage(assistantNode, assistantMessage, { streaming: true })
    return false
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
  syncAssistantMessage(assistantNode, assistantMessage, { streaming: true })
  return true
}

function syncAssistantMessage(node, message, opts) {
  updateAssistantNode(node, message, opts)

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

/* -------------------------------------------------------------------- */
/* message rendering                                                     */
/* -------------------------------------------------------------------- */

function createMessageElement(message, opts = {}) {
  const article = document.createElement("article")
  article.className = `message ${message.role}`
  article.dataset.messageId = message.id

  const role = document.createElement("div")
  role.className = "message-role"
  role.textContent = message.role === "assistant" ? "Lyta" : "You"
  article.appendChild(role)

  const card = document.createElement("div")
  card.className = "message-card"

  const body = document.createElement("div")
  body.className = "message-body"
  renderMessageContent(body, message, opts)
  card.appendChild(body)

  if (message.attachments?.length) {
    const stack = document.createElement("div")
    stack.className = "attachment-stack"

    message.attachments.forEach(attachment => {
      stack.appendChild(createAttachmentCard(attachment))
    })

    card.appendChild(stack)
  }

  const footer = document.createElement("div")
  footer.className = "message-footer"
  renderMessageFooter(footer, message)

  if (footer.childElementCount) {
    card.appendChild(footer)
  }

  article.appendChild(card)

  if (message.id === state.selectedMessageId) {
    article.classList.add("is-selected")
  }

  return article
}

function updateAssistantNode(node, message, opts = {}) {
  const body = node.querySelector(".message-body")
  let footer = node.querySelector(".message-footer")

  renderMessageContent(body, message, opts)

  if (!footer) {
    footer = document.createElement("div")
    footer.className = "message-footer"
  }

  renderMessageFooter(footer, message)

  const card = node.querySelector(".message-card")

  if (!footer.parentElement && footer.childElementCount) {
    card.appendChild(footer)
  }

  if (footer.parentElement && !footer.childElementCount) {
    footer.remove()
  }
}

function renderMessageContent(target, message, opts = {}) {
  if (message.role === "assistant") {
    if (!message.content && opts.streaming) {
      target.innerHTML =
        '<div class="skeleton-lines" aria-hidden="true"><span></span><span></span><span></span></div>'
      return
    }

    target.replaceChildren(renderMarkdown(message.content, message.citations, ""))

    if (opts.streaming) {
      const cursor = document.createElement("span")
      cursor.className = "stream-cursor"
      cursor.setAttribute("aria-hidden", "true")
      target.appendChild(cursor)
    }

    return
  }

  target.textContent = message.content || "Attached files"
}

function renderMessageFooter(target, message) {
  target.innerHTML = ""

  if (message.role === "assistant" && message.content.trim()) {
    const actions = document.createElement("div")
    actions.className = "message-actions"

    const copy = document.createElement("button")
    copy.type = "button"
    copy.className = "message-action"
    copy.dataset.copyMessage = message.id
    copy.textContent = "Copy"
    copy.setAttribute("aria-label", "Copy response")
    actions.appendChild(copy)

    const pin = document.createElement("button")
    pin.type = "button"
    pin.className = "message-action"
    pin.dataset.pinMessage = message.id
    pin.textContent =
      message.id === state.selectedMessageId ? "Pinned" : "Pin to board"
    pin.setAttribute("aria-label", "Pin response to output board")
    actions.appendChild(pin)

    target.appendChild(actions)
  }

  if (message.citations.length) {
    const details = document.createElement("details")
    details.className = "sources-disclosure"

    const summary = document.createElement("summary")
    summary.textContent = `Sources (${message.citations.length})`
    details.appendChild(summary)

    const list = document.createElement("div")
    list.className = "sources-list"

    message.citations.forEach((citation, index) => {
      const card = document.createElement("div")
      card.className = "source-card"
      card.dataset.citationIndex = String(index)
      card.tabIndex = -1

      const title = document.createElement("strong")
      title.textContent = `${index + 1} · ${citation.fileName}`

      const meta = document.createElement("p")
      meta.textContent = citation.snippet

      card.append(title, meta)
      list.appendChild(card)
    })

    details.appendChild(list)
    target.appendChild(details)
  }

  if (message.followups.length) {
    const label = document.createElement("p")
    label.className = "followup-label"
    label.textContent = "Next"
    target.appendChild(label)

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

function handleCitationHover(event, active) {
  const marker = event.target.closest(".citation-marker")
  if (!marker) return
  highlightCitation(marker, active)
}

function handleCitationClick(event, container) {
  const marker = event.target.closest(".citation-marker")
  if (!marker) return

  const scope = marker.closest(".message-card") || container
  const details = scope.querySelector(".sources-disclosure")

  if (details) details.open = true

  const match = scope.querySelector(
    `.source-card[data-citation-index="${marker.dataset.citationIndex}"], .board-source[data-citation-index="${marker.dataset.citationIndex}"]`
  )

  match?.scrollIntoView({ behavior: "smooth", block: "nearest" })
  match?.focus()
}

function highlightCitation(marker, active) {
  const scope = marker.closest(".message-card") || marker.closest("#artifactPanel") || document
  const match = scope.querySelector(
    `.source-card[data-citation-index="${marker.dataset.citationIndex}"], .board-source[data-citation-index="${marker.dataset.citationIndex}"]`
  )

  marker.classList.toggle("is-active", active)
  match?.classList.toggle("is-active", active)
}

function copyMessageContent(id) {
  const message = state.messages.find(item => item.id === id)
  if (!message) return

  navigator.clipboard.writeText(message.content).then(() => {
    setComposerStatus("Response copied.", "success")
  }).catch(() => {})
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

  if (!(attachment.kind === "image" && attachment.dataUrl)) {
    const glyph = document.createElement("span")
    glyph.className = "file-glyph"
    glyph.textContent = getFileTypeGlyph(attachment.mimeType, attachment.kind)
    row.appendChild(glyph)
  }

  const copy = document.createElement("div")
  copy.className = "attachment-copy"

  const title = document.createElement("p")
  title.className = "attachment-title"
  title.textContent = attachment.name

  const meta = document.createElement("div")
  meta.className = "attachment-meta"
  meta.textContent = [
    attachment.kind === "image" ? "Image" : "Document",
    formatMimeLabel(attachment.mimeType),
    formatBytes(attachment.size)
  ].join(" · ")

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

/* -------------------------------------------------------------------- */
/* sidebar rendering                                                     */
/* -------------------------------------------------------------------- */

function renderSessions() {
  dom.sessions.innerHTML = ""

  const filtered = state.sessionFilterText
    ? state.sessions.filter(session =>
        session.title.toLowerCase().includes(state.sessionFilterText)
      )
    : state.sessions

  if (!state.sessions.length) {
    const empty = document.createElement("div")
    empty.className = "sidebar-empty"
    empty.textContent = "No saved chats yet."
    dom.sessions.appendChild(empty)
  } else if (!filtered.length) {
    const empty = document.createElement("div")
    empty.className = "sidebar-empty"
    empty.textContent = "No chats match your filter."
    dom.sessions.appendChild(empty)
  }

  filtered.forEach(session => {
    const row = document.createElement("div")
    row.className = `session${session.id === state.sessionId ? " active" : ""}`
    row.dataset.sessionId = session.id
    row.tabIndex = 0
    row.setAttribute("role", "listitem button")

    const copy = document.createElement("div")
    copy.className = "session-copy"

    const title = document.createElement("strong")
    title.textContent = session.title
    copy.appendChild(title)

    const time = document.createElement("span")
    time.className = "session-time"
    time.textContent = formatRelativeTime(session.updatedAt)

    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "session-delete"
    remove.dataset.deleteSession = session.id
    remove.setAttribute("aria-label", `Delete ${session.title}`)
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>'

    row.append(copy, time, remove)
    dom.sessions.appendChild(row)
  })

  dom.sessionCount.textContent = `${state.sessions.length} chat${state.sessions.length === 1 ? "" : "s"}`
}

function renderProfile() {
  const guest = isGuestUser()
  const workspaceLabel = guest ? "Guest" : "Account"

  dom.profileAvatar.textContent = getInitials(state.profile.name)
  dom.workspaceBadge.textContent = workspaceLabel
  dom.workspaceName.textContent = state.profile.workspace
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
  dom.logoutButton.hidden = guest
  delete dom.profileStatus.dataset.state
  dom.profileStatus.textContent = guest
    ? "Guest settings last for the current session only."
    : "Profile updates apply across refreshes."

  syncProfileMenu()
  updateWorkspaceSummary()
}

function syncProfileMenu() {
  const guest = isGuestUser()
  dom.profileMenuName.textContent = state.profile.name
  dom.profileMenuWorkspace.textContent = guest ? "Temporary session" : state.profile.workspace
  dom.menuAuthAction.hidden = !guest
  dom.menuLogoutAction.hidden = guest
}

function renderLibrary() {
  // The review workspace (app-review.js) lists library files as evidence sources.
  document.dispatchEvent(new CustomEvent("lyta:library-changed"))
  dom.libraryList.innerHTML = ""
  dom.libraryStats.textContent = `${state.library.length} file${state.library.length === 1 ? "" : "s"}`
  dom.libraryHint.textContent = isGuestUser()
    ? "Guest files stay with this session."
    : "Files are available across chats."

  renderSidebarLibrary()
  updateWorkspaceSummary()

  if (!state.library.length) {
    const empty = document.createElement("div")
    empty.className = "library-card"
    empty.textContent = "No files yet."
    dom.libraryList.appendChild(empty)
    return
  }

  state.library.forEach(file => {
    const card = document.createElement("article")
    card.className = "library-card"

    const glyph = document.createElement("span")
    glyph.className = "file-glyph"
    glyph.textContent = getFileTypeGlyph(file.mimeType, file.kind)

    const copy = document.createElement("div")
    copy.className = "library-card-copy"

    const title = document.createElement("strong")
    title.textContent = file.name

    const meta = document.createElement("p")
    meta.textContent = [
      formatMimeLabel(file.mimeType),
      formatBytes(file.size),
      formatRelativeTime(file.updatedAt)
    ].filter(Boolean).join(" · ")

    copy.append(title, meta)

    const actions = document.createElement("div")
    actions.className = "library-card-actions"

    const useButton = document.createElement("button")
    useButton.type = "button"
    useButton.className = "icon-button"
    useButton.setAttribute("aria-label", `Use ${file.name} in chat`)
    useButton.title = "Use in chat"
    useButton.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-plus"></use></svg>'
    useButton.addEventListener("click", () => {
      addLibraryFileToDraft(file.libraryFileId)
      closeSettingsPanel()
    })

    const deleteButton = document.createElement("button")
    deleteButton.type = "button"
    deleteButton.className = "icon-button"
    deleteButton.setAttribute("aria-label", `Delete ${file.name}`)
    deleteButton.title = "Delete"
    deleteButton.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>'
    deleteButton.addEventListener("click", async () => {
      await deleteLibraryFile(file.libraryFileId)
    })

    actions.append(useButton, deleteButton)
    card.append(glyph, copy, actions)
    dom.libraryList.appendChild(card)
  })
}

function renderSidebarLibrary() {
  dom.sidebarLibrary.innerHTML = ""

  if (!state.library.length) {
    const empty = document.createElement("div")
    empty.className = "sidebar-empty"
    empty.textContent = "No files yet."
    dom.sidebarLibrary.appendChild(empty)
    return
  }

  state.library.slice(0, 4).forEach(file => {
    const row = document.createElement("button")
    row.type = "button"
    row.className = "sidebar-file"
    row.title = `Attach ${file.name}`

    const glyph = document.createElement("span")
    glyph.className = "file-glyph"
    glyph.textContent = getFileTypeGlyph(file.mimeType, file.kind)

    const copy = document.createElement("span")
    copy.className = "sidebar-file-copy"

    const title = document.createElement("strong")
    title.textContent = file.name

    const meta = document.createElement("span")
    meta.textContent = formatBytes(file.size)

    copy.append(title, meta)

    row.append(glyph, copy)
    row.addEventListener("click", () => {
      addLibraryFileToDraft(file.libraryFileId)
    })

    dom.sidebarLibrary.appendChild(row)
  })
}

function updateWorkspaceSummary() {
  const fileCount = state.library.length
  const chatCount = state.sessions.length

  dom.workspaceSummary.textContent =
    `${fileCount} file${fileCount === 1 ? "" : "s"} · ${chatCount} chat${chatCount === 1 ? "" : "s"}`
}

/* -------------------------------------------------------------------- */
/* composer / attachments                                               */
/* -------------------------------------------------------------------- */

function renderPendingAttachments() {
  dom.attachmentTray.innerHTML = ""

  state.pendingAttachments.forEach(attachment => {
    const chip = document.createElement("div")
    chip.className = "attachment-chip"

    const glyph = document.createElement("span")
    glyph.className = "file-glyph"
    glyph.textContent = getFileTypeGlyph(attachment.mimeType, attachment.kind)

    const copy = document.createElement("span")
    copy.className = "attachment-chip-copy"

    const name = document.createElement("span")
    name.className = "attachment-chip-name"
    name.textContent = attachment.name

    const size = document.createElement("span")
    size.className = "attachment-chip-size"
    size.textContent = formatBytes(attachment.size)

    copy.append(name, size)

    const remove = document.createElement("button")
    remove.type = "button"
    remove.className = "attachment-remove"
    remove.dataset.removeAttachment = attachment.id
    remove.setAttribute("aria-label", `Remove ${attachment.name}`)
    remove.innerHTML = '<svg class="icon" aria-hidden="true"><use href="#icon-x"></use></svg>'

    chip.append(glyph, copy, remove)
    dom.attachmentTray.appendChild(chip)
  })

  syncSendButtonState()
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
  syncSendButtonState()
  dom.input.focus()
}

/* -------------------------------------------------------------------- */
/* board                                                                 */
/* -------------------------------------------------------------------- */

function selectBoardMessage(id) {
  if (!id) return
  state.selectedMessageId = id
  renderBoard()

  if (window.matchMedia("(max-width: 980px)").matches) {
    openMobileBoard()
  }
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

function renderBoard() {
  syncSelectedMessageStyles()

  const message = getSelectedAssistantMessage()

  if (!message) {
    dom.boardTitle.textContent = "Board"
    dom.boardMeta.hidden = true
    dom.boardState.hidden = false
    dom.boardBody.hidden = true
    dom.boardSources.hidden = true
    dom.boardBody.innerHTML = ""
    dom.boardSources.innerHTML = ""
    return
  }

  dom.boardTitle.textContent = deriveBoardTitle(message)
  dom.boardMeta.hidden = false
  dom.boardMeta.textContent =
    `${getCurrentSessionTitle()} · ${formatRelativeTime(message.createdAt)}`
  dom.boardState.hidden = true
  dom.boardBody.hidden = false
  dom.boardBody.replaceChildren(renderMarkdown(message.content, message.citations))

  renderBoardSources(message.citations)
}

function renderBoardSources(citations) {
  dom.boardSources.innerHTML = ""

  if (!citations.length) {
    dom.boardSources.hidden = true
    return
  }

  dom.boardSources.hidden = false

  const heading = document.createElement("div")
  heading.className = "board-sources-heading"
  heading.textContent = "Sources"
  dom.boardSources.appendChild(heading)

  citations.forEach((citation, index) => {
    const card = document.createElement("div")
    card.className = "board-source"
    card.dataset.citationIndex = String(index)
    card.tabIndex = -1

    const copy = document.createElement("div")
    copy.className = "board-source-copy"

    const title = document.createElement("strong")
    title.textContent = `${index + 1} · ${citation.fileName}`

    const snippet = document.createElement("p")
    snippet.textContent = citation.snippet

    copy.append(title, snippet)
    card.appendChild(copy)
    dom.boardSources.appendChild(card)
  })
}

/* -------------------------------------------------------------------- */
/* settings / auth / shortcuts panels                                   */
/* -------------------------------------------------------------------- */

function openSettingsPanel(section, returnFocusEl) {
  state.lastFocusedBeforeOverlay = returnFocusEl || document.activeElement
  showOverlay(dom.settingsOverlay)
  document.body.classList.add("settings-open")
  dom.settingsPanel.setAttribute("aria-hidden", "false")
  settingsFocusRelease = trapFocus(dom.settingsPanel)
  dom.closeSettings.focus()

  if (section === "library") {
    dom.librarySection.scrollIntoView({
      behavior: "smooth",
      block: "start"
    })
  }
}

function closeSettingsPanel() {
  if (!document.body.classList.contains("settings-open")) return
  document.body.classList.remove("settings-open")
  dom.settingsPanel.setAttribute("aria-hidden", "true")
  hideOverlay(dom.settingsOverlay)
  settingsFocusRelease?.()
  settingsFocusRelease = null
  state.lastFocusedBeforeOverlay?.focus?.()
}

function openAuthModal(returnFocusEl) {
  const anchor = returnFocusEl || document.activeElement
  closeSettingsPanel()
  state.lastFocusedBeforeOverlay = anchor
  showOverlay(dom.authOverlay)
  dom.authModal.hidden = false
  dom.authModal.setAttribute("aria-hidden", "false")
  document.body.classList.add("modal-open")
  authFocusRelease = trapFocus(dom.authModal)
  setAuthStatus("")
  ;(state.authMode === "register" ? dom.authName : dom.authEmail).focus()
}

function closeAuthModal() {
  if (dom.authModal.hidden) return
  dom.authModal.hidden = true
  dom.authModal.setAttribute("aria-hidden", "true")
  document.body.classList.remove("modal-open")
  hideOverlay(dom.authOverlay)
  authFocusRelease?.()
  authFocusRelease = null
  state.lastFocusedBeforeOverlay?.focus?.()
}

function openShortcuts(returnFocusEl) {
  state.lastFocusedBeforeOverlay = returnFocusEl || document.activeElement
  showOverlay(dom.shortcutsOverlay)
  dom.shortcutsSheet.hidden = false
  dom.shortcutsSheet.setAttribute("aria-hidden", "false")
  document.body.classList.add("modal-open")
  shortcutsFocusRelease = trapFocus(dom.shortcutsSheet)
  dom.closeShortcuts.focus()
}

function closeShortcuts() {
  if (dom.shortcutsSheet.hidden) return
  dom.shortcutsSheet.hidden = true
  dom.shortcutsSheet.setAttribute("aria-hidden", "true")
  document.body.classList.remove("modal-open")
  hideOverlay(dom.shortcutsOverlay)
  shortcutsFocusRelease?.()
  shortcutsFocusRelease = null
  state.lastFocusedBeforeOverlay?.focus?.()
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
  } catch (error) {
    setProfileStatus(
      getErrorMessage(error, "Unable to save the profile."),
      "error"
    )
  }
}

/* -------------------------------------------------------------------- */
/* preferences                                                           */
/* -------------------------------------------------------------------- */

function applyUiPreferences(ui, persist = false) {
  state.preferences.ui = {
    sidebarHidden: Boolean(ui?.sidebarHidden),
    boardOpen: ui?.boardOpen !== false,
    chatMode: normalizeChatModeValue(ui?.chatMode)
  }

  document.body.classList.toggle("sidebar-rail", state.preferences.ui.sidebarHidden)
  document.body.classList.toggle("board-closed", !state.preferences.ui.boardOpen)

  dom.sidebarCollapseToggle.setAttribute(
    "aria-label",
    state.preferences.ui.sidebarHidden ? "Expand sidebar" : "Collapse sidebar"
  )

  dom.boardToggle.setAttribute(
    "aria-label",
    state.preferences.ui.boardOpen ? "Hide output board" : "Show output board"
  )

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
      ui: state.preferences.ui
    })
  })
}

function syncModeButtons() {
  const allModeButtons = [...dom.chatModeButtons, ...dom.topbarOverflowMenu.querySelectorAll("[data-chat-mode]")]

  allModeButtons.forEach(button => {
    const active = normalizeChatModeValue(button.dataset.chatMode) === state.preferences.ui.chatMode

    if (button.hasAttribute("aria-pressed")) {
      button.setAttribute("aria-pressed", active ? "true" : "false")
    }

    if (button.getAttribute("role") === "menuitemradio") {
      button.setAttribute("aria-checked", active ? "true" : "false")
    }

    button.classList.toggle("is-active", active)
  })
}

function syncAuthMode() {
  const isRegister = state.authMode === "register"

  dom.authTabs.forEach(button => {
    const active = button.dataset.authMode === state.authMode
    button.classList.toggle("is-active", active)
    button.setAttribute("aria-selected", active ? "true" : "false")
  })

  dom.authNameField.hidden = !isRegister
  dom.authSubmit.textContent = isRegister ? "Create Workspace" : "Sign In"
  dom.authPassword.autocomplete = isRegister ? "new-password" : "current-password"
}

function isGuestUser() {
  return Boolean(state.user?.isGuest)
}

function getDefaultStatus() {
  return "Ready."
}

function setSendingState(active) {
  dom.attachBtn.disabled = active
  dom.libraryBtn.disabled = active
  dom.sendButton.classList.toggle("is-stop", active)
  dom.sendButton.setAttribute("aria-label", active ? "Stop generating" : "Send message")
  dom.sendButton.title = active ? "Stop generating (Esc)" : "Send (⌘↵)"

  const use = dom.sendButton.querySelector("use")
  if (use) use.setAttribute("href", active ? "#icon-stop" : "#icon-send")

  dom.conversationSurface.setAttribute("aria-busy", active ? "true" : "false")
  syncSendButtonState()
}

function syncSendButtonState() {
  if (state.sending) {
    dom.sendButton.disabled = false
    return
  }

  const hasContent = dom.input.value.trim().length > 0 || state.pendingAttachments.length > 0
  dom.sendButton.disabled = !hasContent
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

function scrollConversation() {
  requestAnimationFrame(() => {
    dom.conversationSurface.scrollTop = dom.conversationSurface.scrollHeight
  })
}

function autoresizeTextarea() {
  dom.input.style.height = "0px"
  dom.input.style.height = `${Math.min(dom.input.scrollHeight, 200)}px`
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
  updateWorkspaceSummary()
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
    const selected = node.dataset.messageId === state.selectedMessageId
    node.classList.toggle("is-selected", selected)

    const pin = node.querySelector("[data-pin-message]")

    if (pin) {
      pin.textContent = selected ? "Pinned" : "Pin to board"
    }
  })
}

function deriveBoardTitle(message) {
  const heading =
    message.content.match(/^#+\s+(.+)$/m)?.[1] ||
    message.content.split("\n").find(line => line.trim()) ||
    getCurrentSessionTitle()

  return heading.trim().slice(0, 60) || "Selected Output"
}
