// Review workspace: the review brief is the centre panel, source evidence is
// the adjacent panel, and records/reviews live in the sidebar. Chat stays one
// switch away. Kept separate from app.js so the review workflow can grow
// without touching the chat client; typed helpers live in
// pages-src/app-review-core.ts. All untrusted text goes through textContent.
;(() => {
  const {
    normalizeLibraryFiles,
    formatRelativeTime,
    setStatusState,
    getErrorMessage,
    apiJson,
    extractResponseErrorMessage,
    announce
  } = window.LytaCore

  const {
    READINESS_LABELS,
    CLASSIFICATION_LABELS,
    DISPOSITIONS,
    RECORD_KINDS,
    CONTEXT_KIND_LABELS,
    CHALLENGE_OUTCOME_LABELS,
    normalizeReview,
    normalizeReviewSummaries,
    normalizeContextRecords,
    getFindingEvidence,
    describeEvidenceState,
    describeRetrieval,
    buildReviewAnnouncement,
    buildChallengeAnnouncement,
    countRecordsByKind,
    reviewPath,
    findingPath,
    challengePath
  } = window.LytaReview

  const VIEW_KEY = "lyta_workspace_view"
  const MOBILE_QUERY = window.matchMedia("(max-width: 980px)")
  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

  const $ = id => document.getElementById(id)

  const dom = {
    viewSwitch: $("viewSwitch"),
    openReview: $("openReview"),
    openRecords: $("openRecords"),
    newChat: $("newChat"),
    sessions: $("sessions"),
    sidebarAddFile: $("sidebarAddFile"),
    sidebarBackdrop: $("sidebarBackdrop"),
    sidebarReviews: $("sidebarReviews"),
    reviewCount: $("reviewCount"),
    sidebarRecords: $("sidebarRecords"),
    recordCount: $("recordCount"),
    panel: $("reviewPanel"),
    panelEyebrow: $("reviewPanelEyebrow"),
    panelTitle: $("reviewPanelTitle"),
    newReview: $("reviewNew"),
    rerun: $("reviewRerun"),
    exportButton: $("reviewExport"),
    status: $("reviewStatus"),
    startView: $("reviewStartView"),
    form: $("reviewForm"),
    change: $("reviewChange"),
    outcome: $("reviewOutcome"),
    constraints: $("reviewConstraints"),
    sourceList: $("reviewSourceList"),
    addSources: $("reviewAddSources"),
    submit: $("reviewSubmit"),
    briefView: $("reviewBriefView"),
    brief: $("reviewBrief"),
    recordsView: $("reviewRecordsView"),
    recordForm: $("recordForm"),
    recordKind: $("recordKind"),
    recordTitle: $("recordTitle"),
    recordContent: $("recordContent"),
    recordSourceList: $("recordSourceList"),
    recordSubmit: $("recordSubmit"),
    recordFilter: $("recordFilter"),
    recordsList: $("recordsList"),
    evidencePanel: $("evidencePanel"),
    evidenceBackdrop: $("evidenceBackdrop"),
    evidenceTitle: $("evidenceTitle"),
    evidenceClose: $("evidenceClose"),
    evidenceBody: $("evidenceBody")
  }

  const state = {
    view: "review",
    centre: "start",
    review: null,
    reviews: [],
    selectedFindingId: "",
    documents: [],
    records: [],
    recordsError: "",
    recordFilter: "all",
    running: false,
    lastPayload: null,
    pendingPrefill: null,
    evidenceReturnFocus: null,
    releaseEvidenceFocus: null
  }

  /* ------------------------------------------------------------------ */
  /* wiring                                                              */
  /* ------------------------------------------------------------------ */

  dom.viewSwitch.addEventListener("click", event => {
    const button = event.target.closest("[data-view]")
    if (button) setView(button.dataset.view, { focus: true })
  })
  dom.openReview.addEventListener("click", () => {
    closeSidebarIfMobile()
    setView("review")
    showStart()
  })
  dom.openRecords.addEventListener("click", () => {
    closeSidebarIfMobile()
    setView("review")
    showRecords("all")
  })
  // app.js owns chat sessions; switching to them just changes the view.
  dom.newChat.addEventListener("click", () => setView("chat"))
  dom.sessions.addEventListener("click", event => {
    if (event.target.closest("button, [role='listitem']")) setView("chat")
  })
  dom.newReview.addEventListener("click", () => showStart())
  dom.rerun.addEventListener("click", () => state.review && showStart(state.review))
  dom.exportButton.addEventListener("click", exportReview)
  dom.addSources.addEventListener("click", openLibraryPicker)
  dom.form.addEventListener("submit", submitReview)
  dom.recordForm.addEventListener("submit", submitRecord)
  dom.evidenceClose.addEventListener("click", () => closeEvidenceSheet())
  dom.evidenceBackdrop.addEventListener("click", () => closeEvidenceSheet())

  // Capture phase so the evidence sheet closes before app.js's own Escape handling.
  document.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Escape" || !document.body.classList.contains("evidence-sheet-open")) return
      event.stopPropagation()
      closeEvidenceSheet()
    },
    true
  )

  MOBILE_QUERY.addEventListener("change", () => {
    if (!MOBILE_QUERY.matches) closeEvidenceSheet({ restoreFocus: false })
  })

  document.addEventListener("lyta:library-changed", () => {
    if (state.ready) loadSources()
  })
  document.addEventListener("lyta:workspace-ready", () => {
    state.ready = true
    state.review = null
    state.selectedFindingId = ""
    loadSources()
    loadRecords()
    loadReviews({ openLatest: true })
  })

  renderRecordKindOptions()
  setView(readStoredView())
  showStart()

  /* ------------------------------------------------------------------ */
  /* views                                                               */
  /* ------------------------------------------------------------------ */

  function readStoredView() {
    try {
      return sessionStorage.getItem(VIEW_KEY) === "chat" ? "chat" : "review"
    } catch {
      return "review"
    }
  }

  function setView(view, { focus = false } = {}) {
    state.view = view === "chat" ? "chat" : "review"
    document.body.classList.toggle("view-review", state.view === "review")
    document.body.classList.toggle("view-chat", state.view === "chat")
    dom.viewSwitch.querySelectorAll("[data-view]").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.view === state.view))
    })

    try {
      sessionStorage.setItem(VIEW_KEY, state.view)
    } catch {}

    if (state.view === "chat") {
      closeEvidenceSheet({ restoreFocus: false })
    }

    if (focus) {
      ;(state.view === "review" ? dom.panelTitle : $("message"))?.focus()
    }
  }

  function setCentre(centre, { title, eyebrow }) {
    state.centre = centre
    dom.startView.hidden = centre !== "start"
    dom.briefView.hidden = centre !== "brief"
    dom.recordsView.hidden = centre !== "records"
    dom.newReview.hidden = centre === "start"
    dom.rerun.hidden = centre !== "brief" || !state.review
    dom.exportButton.hidden = centre !== "brief" || !state.review
    dom.panelTitle.textContent = title
    dom.panelEyebrow.textContent = eyebrow
    setStatusState(dom.status, "")
    renderSidebarReviews()
  }

  function showStart(prefill = null) {
    if (!state.running) {
      state.review = null
      state.selectedFindingId = ""
    }
    setCentre("start", { title: "Review a change", eyebrow: "Architecture Change Review" })

    if (prefill) {
      dom.change.value = prefill.proposedChange || ""
      dom.outcome.value = prefill.intendedOutcome || ""
      dom.constraints.value = prefill.constraints || ""
      state.pendingPrefill = prefill.sourceFileIds || []
      renderSourceOptions()
    }

    renderEvidence()
    dom.change.focus()
  }

  function showBrief(review) {
    state.review = review
    if (!review.findings.some(finding => finding.id === state.selectedFindingId)) {
      state.selectedFindingId = review.findings[0]?.id || ""
    }
    setCentre("brief", { title: "Review brief", eyebrow: truncate(review.proposedChange, 90) || "Architecture Change Review" })
    renderBrief()
    renderEvidence()
  }

  function showRecords(kind = state.recordFilter) {
    state.recordFilter = kind
    setCentre("records", { title: "Project records", eyebrow: "Decisions, risks, assumptions, follow-ups" })
    renderRecords()
    renderEvidence()
    dom.panelTitle.focus()
  }

  function closeSidebarIfMobile() {
    if (document.body.classList.contains("sidebar-mobile-open")) dom.sidebarBackdrop.click()
  }

  function openLibraryPicker() {
    dom.sidebarAddFile.click()
  }

  /* ------------------------------------------------------------------ */
  /* sidebar: reviews and records                                        */
  /* ------------------------------------------------------------------ */

  async function loadReviews({ openLatest = false } = {}) {
    try {
      const data = await apiJson("/reviews")
      state.reviews = normalizeReviewSummaries(data.reviews)
    } catch {
      state.reviews = []
    }

    renderSidebarReviews()

    if (openLatest && state.reviews.length && state.centre === "start" && !dom.change.value.trim()) {
      await openStoredReview(state.reviews[0].id, { focus: false })
    }
  }

  function renderSidebarReviews() {
    dom.reviewCount.textContent = `${state.reviews.length} review${state.reviews.length === 1 ? "" : "s"}`

    if (!state.reviews.length) {
      dom.sidebarReviews.replaceChildren(createListNote("No reviews yet. Use Review a change to start one."))
      return
    }

    dom.sidebarReviews.replaceChildren(
      ...state.reviews.slice(0, 8).map(summary => {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        button.className = "sidebar-list-button"
        if (state.centre === "brief" && state.review?.id === summary.id) button.setAttribute("aria-current", "true")
        const title = document.createElement("span")
        title.textContent = summary.title
        const meta = document.createElement("span")
        meta.className = "sidebar-list-meta"
        meta.textContent = READINESS_LABELS[summary.readiness]
        button.append(title, meta)
        button.setAttribute("aria-label", `${summary.title}. ${READINESS_LABELS[summary.readiness]}, ${summary.findingCount} findings.`)
        button.addEventListener("click", () => {
          closeSidebarIfMobile()
          setView("review")
          openStoredReview(summary.id)
        })
        item.append(button)
        return item
      })
    )
  }

  async function openStoredReview(reviewId, { focus = true } = {}) {
    try {
      const data = await apiJson(reviewPath(reviewId))
      const review = normalizeReview(data.review)
      if (!review) throw new Error("That review could not be read.")
      showBrief(review)
      if (focus) dom.panelTitle.focus()
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Unable to open that review."), "error")
    }
  }

  async function loadRecords() {
    try {
      state.records = normalizeContextRecords(await apiJson("/context?includeContent=true"))
      state.recordsError = ""
    } catch (error) {
      state.recordsError = getErrorMessage(error, "Unable to load project records.")
    }

    renderSidebarRecords()
    if (state.centre === "records") renderRecords()
  }

  function renderSidebarRecords() {
    const counts = countRecordsByKind(state.records)
    const kinds = Object.keys(CONTEXT_KIND_LABELS).filter(kind => counts[kind])
    dom.recordCount.textContent = `${state.records.length} record${state.records.length === 1 ? "" : "s"}`

    if (!kinds.length) {
      dom.sidebarRecords.replaceChildren(createListNote(state.recordsError || "No records yet. Accept a finding or add one."))
      return
    }

    dom.sidebarRecords.replaceChildren(
      ...kinds.map(kind => {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        button.className = "sidebar-list-button"
        const label = document.createElement("span")
        label.textContent = CONTEXT_KIND_LABELS[kind]
        const meta = document.createElement("span")
        meta.className = "sidebar-list-meta"
        meta.textContent = String(counts[kind])
        button.append(label, meta)
        button.addEventListener("click", () => {
          closeSidebarIfMobile()
          setView("review")
          showRecords(kind)
        })
        item.append(button)
        return item
      })
    )
  }

  /* ------------------------------------------------------------------ */
  /* sources                                                             */
  /* ------------------------------------------------------------------ */

  async function loadSources() {
    try {
      const files = []
      let cursor = "0"

      // The library holds at most 40 files, so a few pages cover it.
      for (let page = 0; page < 3 && cursor !== null; page++) {
        const data = await apiJson(`/library?cursor=${encodeURIComponent(cursor)}`)
        files.push(...normalizeLibraryFiles(data.files))
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : null
      }

      state.documents = files.filter(file => file.kind === "document")
    } catch {
      state.documents = []
    }

    renderSourceOptions()
  }

  function renderSourceOptions() {
    const selected = new Set([
      ...checkedValues(dom.sourceList, "reviewSource"),
      ...(state.pendingPrefill || [])
    ])
    const recordSelected = new Set(checkedValues(dom.recordSourceList, "recordSource"))
    state.pendingPrefill = null

    for (const [container, name, chosen] of [
      [dom.sourceList, "reviewSource", selected],
      [dom.recordSourceList, "recordSource", recordSelected]
    ]) {
      if (!state.documents.length) {
        container.replaceChildren(
          createNote("No documents in the library yet. Add design docs, ADRs, or runbooks; reviews only use library files as evidence.")
        )
        continue
      }

      container.replaceChildren(
        ...state.documents.map(file => {
          const label = document.createElement("label")
          label.className = "review-source"
          const input = document.createElement("input")
          input.type = "checkbox"
          input.name = name
          input.value = file.libraryFileId
          input.checked = chosen.has(file.libraryFileId)
          const fileName = document.createElement("span")
          fileName.textContent = file.name
          label.append(input, fileName)
          return label
        })
      )
    }
  }

  function checkedValues(container, name) {
    return Array.from(container.querySelectorAll(`input[name="${name}"]:checked`)).map(input => input.value)
  }

  /* ------------------------------------------------------------------ */
  /* running a review                                                    */
  /* ------------------------------------------------------------------ */

  function submitReview(event) {
    event.preventDefault()
    if (state.running) return

    const payload = {
      proposedChange: dom.change.value.trim(),
      intendedOutcome: dom.outcome.value.trim(),
      constraints: dom.constraints.value.trim(),
      sourceFileIds: checkedValues(dom.sourceList, "reviewSource")
    }
    const invalid = !payload.proposedChange ? dom.change : !payload.intendedOutcome ? dom.outcome : null

    if (invalid) {
      setStatusState(dom.status, invalid === dom.change ? "Describe the proposed change." : "Describe the intended outcome.", "error")
      invalid.focus()
      return
    }

    if (!payload.sourceFileIds.length) {
      setStatusState(dom.status, "Select at least one library source.", "error")
      ;(dom.sourceList.querySelector("input") || dom.addSources).focus()
      return
    }

    runReview(payload)
  }

  async function runReview(payload) {
    state.running = true
    state.lastPayload = payload
    state.review = null
    dom.submit.disabled = true
    dom.panel.setAttribute("aria-busy", "true")
    setCentre("brief", { title: "Reviewing…", eyebrow: truncate(payload.proposedChange, 90) })
    dom.brief.replaceChildren(renderLoading(payload.sourceFileIds.length))
    renderEvidence()
    setStatusState(dom.status, "Retrieving evidence and reviewing the change. This usually takes a few seconds.")
    dom.panelTitle.focus()

    try {
      const data = await apiJson("/reviews", { method: "POST", body: JSON.stringify(payload) })
      const review = normalizeReview(data.review)
      if (!review) throw new Error("The review response was incomplete.")
      dom.form.reset()
      state.running = false
      showBrief(review)
      announce(buildReviewAnnouncement(review))
      dom.panelTitle.focus()
      loadReviews()
    } catch (error) {
      state.running = false
      renderFailure(getErrorMessage(error, "The review failed. Please retry."))
    } finally {
      state.running = false
      dom.submit.disabled = false
      dom.panel.removeAttribute("aria-busy")
    }
  }

  function renderLoading(sourceCount) {
    const block = document.createElement("div")
    block.className = "review-loading"
    const text = document.createElement("p")
    text.className = "settings-note"
    text.textContent = `Searching ${sourceCount} selected source${sourceCount === 1 ? "" : "s"} for evidence, then checking every claim against it…`
    const skeleton = document.createElement("div")
    skeleton.className = "skeleton-lines"
    skeleton.setAttribute("aria-hidden", "true")
    skeleton.append(document.createElement("span"), document.createElement("span"), document.createElement("span"))
    block.append(text, skeleton)
    return block
  }

  function renderFailure(message) {
    dom.panelTitle.textContent = "Review failed"
    const callout = createCallout("danger", "The review did not complete", message)
    callout.append(createNote("Nothing was saved. Your change description and source selection are kept."))
    const actions = document.createElement("div")
    actions.className = "record-actions"
    const retry = createButton("Retry", "primary-button", () => state.lastPayload && runReview(state.lastPayload))
    const edit = createButton("Edit the change", "secondary-button", () => showStart(state.lastPayload))
    actions.append(retry, edit)
    callout.append(actions)
    dom.brief.replaceChildren(callout)
    setStatusState(dom.status, message, "error")
    announce(`Review failed. ${message}`, "assertive")
    retry.focus()
  }

  /* ------------------------------------------------------------------ */
  /* brief (centre panel)                                                */
  /* ------------------------------------------------------------------ */

  function renderBrief() {
    const review = state.review
    if (!review) return

    const verdict = document.createElement("section")
    verdict.className = "review-verdict"
    verdict.dataset.readiness = review.readiness
    verdict.setAttribute("aria-label", "Readiness verdict")
    const badge = document.createElement("p")
    badge.className = "review-readiness"
    badge.textContent = READINESS_LABELS[review.readiness]
    const rationale = document.createElement("p")
    rationale.className = "review-rationale"
    rationale.textContent = review.rationale
    verdict.append(badge, rationale, createNote(`Sources: ${review.sourceNames.join(", ") || "none"}`))

    const sections = [verdict]

    if (review.readiness === "needs evidence") {
      const callout = createCallout(
        "warning",
        "This change needs more evidence",
        review.missingEvidence.length
          ? "The review could not support a ready verdict. Close these gaps, then re-run it:"
          : "The review could not support a ready verdict from the selected sources."
      )
      if (review.missingEvidence.length) callout.append(createList(review.missingEvidence))
      const actions = document.createElement("div")
      actions.className = "record-actions"
      actions.append(
        createButton("Add files to the library", "secondary-button", openLibraryPicker),
        createButton("Edit and re-run", "secondary-button", () => showStart(review))
      )
      callout.append(actions)
      sections.push(callout)
    } else if (review.readiness === "blocked") {
      sections.push(createCallout("danger", "Blocked", "The evidence shows a defect or unmet prerequisite. Inspect the findings below before going further."))
    }

    const findings = document.createElement("section")
    findings.setAttribute("aria-labelledby", "reviewFindingsTitle")
    findings.append(createHeading("Findings", "reviewFindingsTitle"))
    findings.append(createNote("Select a finding to inspect its source evidence, challenge it, or save it as a record."))

    if (review.findings.length) {
      const list = document.createElement("ol")
      list.className = "review-findings"
      list.id = "reviewFindingList"
      list.append(...review.findings.map(renderFindingRow))
      findings.append(list)
    } else {
      findings.append(createNote("No findings were returned."))
    }

    sections.push(findings)

    if (review.conflicts.length) {
      sections.push(
        renderListSection(
          "Conflicting sources",
          review.conflicts.map(conflict => `${conflict.description} (${describeCitations(review, conflict.citationIds)})`),
          ""
        )
      )
    }

    sections.push(
      renderListSection("Required tests", review.requiredTests, "No test evidence identified; coverage is unproven."),
      renderListSection("Observability", review.observability, "No observability evidence identified."),
      renderListSection("Rollback", review.rollback, "No rollback evidence identified; rollback is unproven."),
      renderListSection("Assumptions", review.assumptions, "None recorded."),
      renderListSection("Open questions", review.openQuestions, "None recorded."),
      renderListSection("Next actions", review.nextActions, "None recorded.")
    )

    if (review.missingEvidence.length && review.readiness !== "needs evidence") {
      sections.push(renderListSection("Missing evidence", review.missingEvidence, ""))
    }

    if (review.adjustments.length) {
      sections.push(renderListSection("Server-side corrections", review.adjustments, ""))
    }

    dom.brief.replaceChildren(...sections)
  }

  function renderFindingRow(finding) {
    const item = document.createElement("li")
    const evidence = getFindingEvidence(state.review, finding)
    const button = document.createElement("button")
    button.type = "button"
    button.className = "review-finding-select"
    button.dataset.findingId = finding.id
    button.dataset.classification = finding.classification
    button.dataset.withdrawn = String(finding.withdrawn)
    button.setAttribute("aria-pressed", String(finding.id === state.selectedFindingId))
    button.setAttribute("aria-controls", "evidencePanel")

    const chip = document.createElement("span")
    chip.className = "review-chip"
    chip.textContent = finding.withdrawn ? "Withdrawn" : CLASSIFICATION_LABELS[finding.classification]
    const title = document.createElement("span")
    title.className = "review-finding-title"
    title.textContent = `${finding.id} · ${finding.title}`
    const meta = document.createElement("span")
    meta.className = "review-finding-area"
    meta.textContent = [
      `${finding.areaType}${finding.area ? ` — ${finding.area}` : ""}`,
      evidence.length ? `${evidence.length} source${evidence.length === 1 ? "" : "s"}` : "no sources cited",
      finding.disposition !== "unresolved" ? `${finding.disposition}${finding.recordKind ? ` as ${finding.recordKind}` : ""}` : "",
      finding.challenges.length ? `challenged ${finding.challenges.length}×` : ""
    ]
      .filter(Boolean)
      .join(" · ")
    button.append(chip, title, meta)
    button.addEventListener("click", () => selectFinding(finding.id, button))
    item.append(button)
    return item
  }

  function selectFinding(findingId, trigger) {
    state.selectedFindingId = findingId
    dom.brief.querySelectorAll(".review-finding-select").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.findingId === findingId))
    })
    renderEvidence()

    const finding = state.review?.findings.find(candidate => candidate.id === findingId)
    if (finding) {
      const count = getFindingEvidence(state.review, finding).length
      announce(`Showing evidence for ${finding.id}: ${count ? `${count} source passage${count === 1 ? "" : "s"}` : "no source passages"}.`)
    }

    if (MOBILE_QUERY.matches) openEvidenceSheet(trigger)
  }

  function rerenderAfterUpdate(review, focusSelector) {
    state.review = review
    renderBrief()
    renderEvidence()
    renderSidebarReviews()
    if (focusSelector) dom.evidenceBody.querySelector(focusSelector)?.focus()
  }

  /* ------------------------------------------------------------------ */
  /* evidence inspector (adjacent panel)                                 */
  /* ------------------------------------------------------------------ */

  function renderEvidence() {
    const review = state.centre === "brief" ? state.review : null
    const finding = review?.findings.find(candidate => candidate.id === state.selectedFindingId)

    if (!review || !finding) {
      dom.evidenceTitle.textContent = "Evidence"
      dom.evidenceBody.replaceChildren(
        createNote(
          state.running
            ? "Evidence appears here once the review is ready."
            : review
              ? "Select a finding to see the exact source passages behind it."
              : "Open a review from the sidebar, or run one, to inspect the evidence behind each claim."
        )
      )
      return
    }

    const evidence = getFindingEvidence(review, finding)
    const evidenceState = describeEvidenceState(finding, evidence.filter(item => !item.sourceDeleted).length)
    dom.evidenceTitle.textContent = `Evidence for ${finding.id}`

    const claim = document.createElement("h3")
    claim.textContent = finding.title
    const parts = [claim]
    if (finding.detail) parts.push(createParagraph(finding.detail))

    const stateBlock = document.createElement("div")
    stateBlock.className = "evidence-state"
    stateBlock.dataset.state = evidenceState.state
    const stateLabel = document.createElement("strong")
    stateLabel.textContent = evidenceState.label
    stateBlock.append(stateLabel, createParagraph(evidenceState.description))
    finding.adjustments.forEach(adjustment => stateBlock.append(createNote(`Server correction: ${adjustment}`)))
    parts.push(stateBlock)

    const passages = document.createElement("section")
    passages.setAttribute("aria-labelledby", "evidencePassagesTitle")
    passages.append(createHeading("Source passages", "evidencePassagesTitle"))

    if (evidence.length) {
      passages.append(...evidence.map(item => renderEvidenceCard(review, finding, item)))
    } else {
      const callout = createCallout(
        "warning",
        "No retrieved passage supports this claim",
        "Challenge it to search the review's sources again, or add material that covers it."
      )
      const actions = document.createElement("div")
      actions.className = "record-actions"
      actions.append(
        createButton("Add files to the library", "secondary-button", openLibraryPicker),
        ...(finding.withdrawn ? [] : [createButton("Challenge it", "secondary-button", () => $("challengeReason")?.focus())])
      )
      callout.append(actions)
      passages.append(callout)
    }
    parts.push(passages)

    if (finding.challenges.length) parts.push(renderChallengeHistory(review, finding))
    if (!finding.withdrawn) parts.push(renderChallengeForm(review, finding))
    parts.push(renderDispositionControls(review, finding))

    dom.evidenceBody.replaceChildren(...parts)
  }

  function renderEvidenceCard(review, finding, item) {
    const card = document.createElement("article")
    card.className = "evidence-card"
    const heading = document.createElement("h4")
    heading.textContent = `${item.ref} · ${item.fileName}`
    const source = review.sources.find(candidate => candidate.fileId === item.fileId)
    const alsoCitedBy = review.findings
      .filter(candidate => candidate.id !== finding.id && candidate.citationIds.includes(item.chunkId))
      .map(candidate => candidate.id)

    const meta = document.createElement("dl")
    meta.className = "evidence-meta"
    appendMeta(meta, "File", item.fileName)
    appendMeta(meta, "File id", item.fileId, true)
    if (source?.sourceVersionId) appendMeta(meta, "Version", source.sourceVersionId, true)
    appendMeta(meta, "Passage", item.chunkId, true)
    appendMeta(meta, "Retrieval", describeRetrieval(review, item))
    if (alsoCitedBy.length) appendMeta(meta, "Also cited by", alsoCitedBy.join(", "))

    const label = createNote(item.sourceDeleted ? "Excerpt removed" : "Excerpt (start of the retrieved passage)")
    const excerpt = document.createElement("blockquote")
    excerpt.className = "evidence-excerpt"
    excerpt.textContent = item.sourceDeleted ? "This source was deleted after the review, so its excerpt is no longer stored." : item.snippet

    card.append(heading, meta, label, excerpt)
    return card
  }

  function appendMeta(list, term, value, code = false) {
    const dt = document.createElement("dt")
    dt.textContent = term
    const dd = document.createElement("dd")
    if (code) {
      const element = document.createElement("code")
      element.textContent = value
      dd.append(element)
    } else {
      dd.textContent = value
    }
    list.append(dt, dd)
  }

  function renderChallengeHistory(review, finding) {
    const section = document.createElement("section")
    section.className = "review-finding-panel"
    section.setAttribute("aria-labelledby", "evidenceHistoryTitle")
    section.append(createHeading("Challenge history", "evidenceHistoryTitle"))

    finding.challenges.forEach(challenge => {
      const entry = document.createElement("div")
      entry.className = "review-history-entry"
      entry.dataset.changed = String(challenge.conclusionChanged)
      entry.append(
        createParagraph(
          `${challenge.id} · ${CHALLENGE_OUTCOME_LABELS[challenge.outcome]} · conclusion ${
            challenge.conclusionChanged ? "changed" : "unchanged"
          } · ${formatRelativeTime(challenge.createdAt)}`
        )
      )
      if (challenge.reason) entry.append(createNote(`Challenge: ${challenge.reason}`))
      entry.append(createParagraph(challenge.rationale))
      entry.append(createNote(`Counter-evidence: ${describeCitations(review, challenge.counterEvidenceIds)}`))
      if (challenge.conclusionChanged) {
        entry.append(createNote(`Before: ${challenge.beforeTitle}`), createNote(`After: ${challenge.afterTitle || "withdrawn"}`))
      }
      challenge.adjustments.forEach(adjustment => entry.append(createNote(`Correction: ${adjustment}`)))
      section.append(entry)
    })

    return section
  }

  function renderChallengeForm(review, finding) {
    const form = document.createElement("form")
    form.className = "review-challenge"
    form.noValidate = true
    form.setAttribute("aria-labelledby", "challengeTitle")
    const heading = createHeading("Challenge this conclusion", "challengeTitle")
    const label = document.createElement("label")
    label.className = "settings-field"
    const labelText = document.createElement("span")
    labelText.textContent = "Why do you doubt it? (optional)"
    const reason = document.createElement("textarea")
    reason.id = "challengeReason"
    reason.rows = 2
    reason.maxLength = 500
    label.append(labelText, reason)
    const submit = document.createElement("button")
    submit.type = "submit"
    submit.className = "secondary-button"
    submit.id = "challengeSubmit"
    submit.textContent = "Search for counter-evidence"
    const actions = document.createElement("div")
    actions.className = "settings-actions"
    actions.append(submit)
    form.append(heading, createNote("LYTA searches this review's sources again. The finding only changes if a retrieved passage contradicts it."), label, actions)
    form.addEventListener("submit", event => {
      event.preventDefault()
      challengeFinding(review, finding, reason.value.trim(), submit)
    })
    return form
  }

  async function challengeFinding(review, finding, reason, button) {
    button.disabled = true
    button.textContent = "Searching…"
    dom.evidencePanel.setAttribute("aria-busy", "true")
    setStatusState(dom.status, `Searching the review's sources for counter-evidence to ${finding.id}…`)

    try {
      const data = await apiJson(challengePath(review.id, finding.id), { method: "POST", body: JSON.stringify({ reason }) })
      const updated = normalizeReview(data.review)
      if (!updated) throw new Error("The challenge response was incomplete.")
      const message = buildChallengeAnnouncement(finding.id, data.challenge?.outcome, data.challenge?.conclusionChanged === true)
      rerenderAfterUpdate(updated)
      dom.evidenceTitle.focus()
      setStatusState(dom.status, message, "success")
      announce(message)
      if (data.challenge?.conclusionChanged) loadRecords()
    } catch (error) {
      const message = getErrorMessage(error, "The challenge failed. Please retry.")
      button.disabled = false
      button.textContent = "Search for counter-evidence"
      button.focus()
      setStatusState(dom.status, message, "error")
      announce(message, "assertive")
    } finally {
      dom.evidencePanel.removeAttribute("aria-busy")
    }
  }

  function renderDispositionControls(review, finding) {
    const section = document.createElement("section")
    section.setAttribute("aria-labelledby", "dispositionTitle")
    section.append(createHeading("Decide", "dispositionTitle"))

    const kindLabel = document.createElement("label")
    kindLabel.className = "review-record-kind"
    const kindText = document.createElement("span")
    kindText.textContent = "Save as"
    const kindSelect = document.createElement("select")
    kindSelect.id = "dispositionKind"
    kindSelect.append(
      ...RECORD_KINDS.map(kind => {
        const option = document.createElement("option")
        option.value = kind.value
        option.textContent = kind.label
        option.selected = (finding.recordKind || "finding") === kind.value
        return option
      })
    )
    kindLabel.append(kindText, kindSelect)

    const group = document.createElement("div")
    group.className = "review-disposition"
    group.setAttribute("role", "group")
    group.setAttribute("aria-label", `Disposition for ${finding.id}`)
    DISPOSITIONS.forEach(option => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "secondary-button"
      button.textContent = option.label
      button.dataset.disposition = option.value
      button.setAttribute("aria-pressed", String(finding.disposition === option.value))
      button.disabled = finding.withdrawn && option.value === "accepted"
      button.addEventListener("click", () => setDisposition(review, finding, option.value, kindSelect.value))
      group.append(button)
    })

    section.append(
      kindLabel,
      group,
      createNote(finding.withdrawn ? "Withdrawn findings cannot be accepted." : "Accepting saves the finding to Project records with its sources.")
    )
    return section
  }

  async function setDisposition(review, finding, disposition, recordAs) {
    try {
      const data = await apiJson(findingPath(review.id, finding.id), {
        method: "POST",
        body: JSON.stringify({ disposition, recordAs })
      })
      const updated = normalizeReview(data.review)
      if (!updated) throw new Error("The disposition response was incomplete.")
      rerenderAfterUpdate(updated, `[data-disposition="${disposition}"]`)
      const kind = RECORD_KINDS.find(option => option.value === recordAs)?.label.toLowerCase() || "finding"
      const message =
        disposition === "accepted" ? `${finding.id} accepted and saved to Project records as a ${kind}.` : `${finding.id} marked ${disposition}.`
      setStatusState(dom.status, message, "success")
      announce(message)
      loadRecords()
    } catch (error) {
      const message = getErrorMessage(error, "Unable to save the disposition.")
      setStatusState(dom.status, message, "error")
      announce(message, "assertive")
    }
  }

  function openEvidenceSheet(trigger) {
    state.evidenceReturnFocus = trigger || document.activeElement
    document.body.classList.add("evidence-sheet-open")
    dom.evidenceBackdrop.hidden = false
    requestAnimationFrame(() => dom.evidenceBackdrop.classList.add("is-visible"))
    state.releaseEvidenceFocus?.()
    state.releaseEvidenceFocus = trapFocus(dom.evidencePanel)
    dom.evidenceTitle.focus()
  }

  function closeEvidenceSheet({ restoreFocus = true } = {}) {
    if (!document.body.classList.contains("evidence-sheet-open")) return
    document.body.classList.remove("evidence-sheet-open")
    dom.evidenceBackdrop.classList.remove("is-visible")
    window.setTimeout(() => {
      if (!dom.evidenceBackdrop.classList.contains("is-visible")) dom.evidenceBackdrop.hidden = true
    }, 200)
    state.releaseEvidenceFocus?.()
    state.releaseEvidenceFocus = null
    if (restoreFocus) state.evidenceReturnFocus?.focus?.()
  }

  function trapFocus(container) {
    function handleKeydown(event) {
      if (event.key !== "Tab") return
      const focusable = Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR)).filter(el => el.offsetParent !== null)
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

  /* ------------------------------------------------------------------ */
  /* records (centre panel)                                              */
  /* ------------------------------------------------------------------ */

  function renderRecordKindOptions() {
    dom.recordKind.replaceChildren(
      ...["decision", "risk", "assumption", "follow-up", "finding"].map(value => {
        const option = document.createElement("option")
        option.value = value
        option.textContent = RECORD_KINDS.find(kind => kind.value === value)?.label || value
        return option
      })
    )
  }

  function renderRecords() {
    const counts = countRecordsByKind(state.records)
    const kinds = Object.keys(CONTEXT_KIND_LABELS).filter(kind => counts[kind])

    dom.recordFilter.hidden = !state.records.length
    dom.recordFilter.replaceChildren(
      ...[["all", `All (${state.records.length})`], ...kinds.map(kind => [kind, `${CONTEXT_KIND_LABELS[kind]} (${counts[kind]})`])].map(
        ([value, label]) => {
          const button = document.createElement("button")
          button.type = "button"
          button.className = "mode-button"
          button.textContent = label
          button.setAttribute("aria-pressed", String(state.recordFilter === value))
          button.addEventListener("click", () => {
            state.recordFilter = value
            renderRecords()
          })
          return button
        }
      )
    )

    if (state.recordsError) {
      const callout = createCallout("danger", "Records could not be loaded", state.recordsError)
      callout.append(createButton("Retry", "secondary-button", loadRecords))
      dom.recordsList.replaceChildren(callout)
      return
    }

    if (!state.records.length) {
      dom.recordsList.replaceChildren(createNote("No records yet. Accept a review finding, or use the form above to record a decision directly."))
      return
    }

    const visibleKinds = state.recordFilter === "all" ? kinds : kinds.filter(kind => kind === state.recordFilter)
    dom.recordsList.replaceChildren(
      ...visibleKinds.map(kind => {
        const section = document.createElement("section")
        section.setAttribute("aria-labelledby", `records-${kind}`)
        section.append(createHeading(CONTEXT_KIND_LABELS[kind] || kind, `records-${kind}`))
        const list = document.createElement("ul")
        list.className = "review-findings"
        list.append(...state.records.filter(record => record.kind === kind).map(renderRecord))
        section.append(list)
        return section
      })
    )
  }

  function renderRecord(record) {
    const item = document.createElement("li")
    item.className = "review-record"
    const title = document.createElement("h4")
    title.textContent = record.title
    item.append(
      title,
      createParagraph(record.content),
      createNote(`${record.sourceNames.length ? `Sources: ${record.sourceNames.join(", ")}` : "No linked sources"} · ${formatRelativeTime(record.updatedAt)}`)
    )

    const actions = document.createElement("div")
    actions.className = "record-actions"
    if (record.reviewId) {
      actions.append(
        createButton(`Open review (${record.findingId})`, "secondary-button", () => {
          state.selectedFindingId = record.findingId
          openStoredReview(record.reviewId)
        })
      )
    }
    const remove = createButton("Delete", "secondary-button", () => deleteRecord(record, remove))
    remove.setAttribute("aria-label", `Delete record: ${record.title}`)
    actions.append(remove)
    item.append(actions)
    return item
  }

  async function deleteRecord(record, button) {
    // Two-step delete: the first activation asks for confirmation in place.
    if (button.dataset.confirm !== "true") {
      button.dataset.confirm = "true"
      button.textContent = "Confirm delete"
      button.setAttribute("aria-label", `Confirm deleting record: ${record.title}`)
      announce("Press again to delete this record.")
      return
    }

    try {
      await apiJson("/context/records/delete", { method: "POST", body: JSON.stringify({ id: record.id }) })
      setStatusState(dom.status, `Deleted “${record.title}”.`, "success")
      announce("Record deleted.")
      await loadRecords()
      dom.panelTitle.focus()
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Unable to delete the record."), "error")
    }
  }

  async function submitRecord(event) {
    event.preventDefault()
    const title = dom.recordTitle.value.trim()
    const content = dom.recordContent.value.trim()

    if (!title || !content) {
      setStatusState(dom.status, !title ? "Give the record a title." : "Describe the record.", "error")
      ;(!title ? dom.recordTitle : dom.recordContent).focus()
      return
    }

    dom.recordSubmit.disabled = true

    try {
      await apiJson("/context/records", {
        method: "POST",
        body: JSON.stringify({
          kind: dom.recordKind.value,
          title,
          content,
          provenance: { sourceFileIds: checkedValues(dom.recordSourceList, "recordSource") }
        })
      })
      const kindLabel = dom.recordKind.selectedOptions[0]?.textContent || "Record"
      dom.recordForm.reset()
      renderRecordKindOptions()
      state.recordFilter = "all"
      await loadRecords()
      setStatusState(dom.status, `${kindLabel} saved to Project records.`, "success")
      announce(`${kindLabel} saved.`)
      dom.recordTitle.focus()
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Unable to save the record."), "error")
    } finally {
      dom.recordSubmit.disabled = false
    }
  }

  /* ------------------------------------------------------------------ */
  /* export + small builders                                             */
  /* ------------------------------------------------------------------ */

  async function exportReview() {
    if (!state.review) return

    try {
      const response = await fetch(reviewPath(state.review.id, "export"))
      if (!response.ok) throw new Error(await extractResponseErrorMessage(response, "Export failed."))
      const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/markdown" }))
      const link = document.createElement("a")
      link.href = url
      link.download = `lyta-review-${state.review.id}.md`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatusState(dom.status, "Review brief exported as Markdown.", "success")
      announce("Review brief exported.")
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Export failed."), "error")
    }
  }

  function describeCitations(review, chunkIds) {
    return (
      chunkIds
        .map(chunkId => review.evidence.find(item => item.chunkId === chunkId))
        .filter(Boolean)
        .map(item => `${item.ref} ${item.fileName}`)
        .join("; ") || "none"
    )
  }

  function renderListSection(title, items, emptyText) {
    const section = document.createElement("section")
    const id = `review-section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`
    section.setAttribute("aria-labelledby", id)
    section.append(createHeading(title, id))
    section.append(items.length ? createList(items) : createNote(emptyText))
    return section
  }

  function createList(items) {
    const list = document.createElement("ul")
    list.className = "review-list"
    list.append(
      ...items.map(text => {
        const item = document.createElement("li")
        item.textContent = text
        return item
      })
    )
    return list
  }

  function createCallout(tone, title, text) {
    const callout = document.createElement("div")
    callout.className = "review-callout"
    callout.dataset.tone = tone
    const heading = document.createElement("h3")
    heading.textContent = title
    callout.append(heading, createParagraph(text))
    return callout
  }

  function createButton(label, className, onClick) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = className
    button.textContent = label
    button.addEventListener("click", onClick)
    return button
  }

  function createHeading(text, id) {
    const heading = document.createElement("h3")
    heading.className = "review-section-title"
    heading.id = id
    heading.textContent = text
    return heading
  }

  function createParagraph(text) {
    const paragraph = document.createElement("p")
    paragraph.textContent = text
    return paragraph
  }

  function createNote(text) {
    const note = document.createElement("p")
    note.className = "settings-note"
    note.textContent = text
    return note
  }

  function createListNote(text) {
    const item = document.createElement("li")
    item.className = "sidebar-empty"
    item.textContent = text
    return item
  }

  function truncate(text, limit) {
    return text.length > limit ? `${text.slice(0, limit - 1)}…` : text
  }
})()
