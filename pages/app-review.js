// Architecture Change Review dialog. Kept separate from app.js so the review
// workflow can grow without touching the chat client; typed helpers live in
// pages-src/app-review-core.ts.
;(() => {
  const { normalizeLibraryFiles, formatRelativeTime, setStatusState, getErrorMessage, apiJson, extractResponseErrorMessage } =
    window.LytaCore

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
    reviewPath,
    findingPath,
    challengePath
  } = window.LytaReview

  const FOCUSABLE_SELECTOR =
    'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])'

  const dom = {
    openReview: document.getElementById("openReview"),
    openRecords: document.getElementById("openRecords"),
    showRecords: document.getElementById("reviewShowRecords"),
    recordsView: document.getElementById("reviewRecordsView"),
    recordsBack: document.getElementById("recordsBack"),
    recordsStatus: document.getElementById("recordsStatus"),
    recordsList: document.getElementById("recordsList"),
    overlay: document.getElementById("reviewOverlay"),
    dialog: document.getElementById("reviewDialog"),
    title: document.getElementById("reviewTitle"),
    close: document.getElementById("closeReview"),
    formView: document.getElementById("reviewFormView"),
    form: document.getElementById("reviewForm"),
    change: document.getElementById("reviewChange"),
    outcome: document.getElementById("reviewOutcome"),
    constraints: document.getElementById("reviewConstraints"),
    sourceList: document.getElementById("reviewSourceList"),
    submit: document.getElementById("reviewSubmit"),
    status: document.getElementById("reviewStatus"),
    history: document.getElementById("reviewHistory"),
    historyList: document.getElementById("reviewHistoryList"),
    briefView: document.getElementById("reviewBriefView"),
    back: document.getElementById("reviewBack"),
    exportButton: document.getElementById("reviewExport"),
    briefStatus: document.getElementById("reviewBriefStatus"),
    brief: document.getElementById("reviewBrief")
  }

  const state = {
    review: null,
    running: false,
    lastFocused: null,
    releaseFocus: null
  }

  dom.openReview.addEventListener("click", () => openReviewDialog(dom.openReview))
  dom.openRecords.addEventListener("click", () => openReviewDialog(dom.openRecords, "records"))
  dom.showRecords.addEventListener("click", showRecordsView)
  dom.recordsBack.addEventListener("click", showFormView)
  dom.close.addEventListener("click", closeReviewDialog)
  dom.overlay.addEventListener("click", closeReviewDialog)
  dom.back.addEventListener("click", showFormView)
  dom.exportButton.addEventListener("click", exportReview)
  dom.form.addEventListener("submit", submitReview)

  // Capture phase so Escape works even if focus fell back to <body>, and so
  // app.js's global Escape handler does not also close a layer underneath.
  document.addEventListener(
    "keydown",
    event => {
      if (event.key !== "Escape" || dom.dialog.hidden) return
      event.stopPropagation()
      closeReviewDialog()
    },
    true
  )

  /* ------------------------------------------------------------------ */
  /* dialog lifecycle                                                    */
  /* ------------------------------------------------------------------ */

  function openReviewDialog(returnFocusEl, view = "form") {
    state.lastFocused = returnFocusEl || document.activeElement
    dom.overlay.hidden = false
    requestAnimationFrame(() => dom.overlay.classList.add("is-visible"))
    dom.dialog.hidden = false
    dom.dialog.setAttribute("aria-hidden", "false")
    document.body.classList.add("modal-open")
    state.releaseFocus = trapFocus(dom.dialog)
    view === "records" ? showRecordsView() : showFormView()
  }

  function closeReviewDialog() {
    if (dom.dialog.hidden) return
    dom.dialog.hidden = true
    dom.dialog.setAttribute("aria-hidden", "true")
    document.body.classList.remove("modal-open")
    dom.overlay.classList.remove("is-visible")
    window.setTimeout(() => {
      if (!dom.overlay.classList.contains("is-visible")) dom.overlay.hidden = true
    }, 200)
    state.releaseFocus?.()
    state.releaseFocus = null
    state.lastFocused?.focus?.()
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

  function showFormView() {
    dom.briefView.hidden = true
    dom.recordsView.hidden = true
    dom.formView.hidden = false
    dom.title.textContent = "Review a change"
    setStatusState(dom.status, "")
    dom.change.focus()
    loadSources()
    loadHistory()
  }

  function showBriefView(review) {
    state.review = review
    dom.formView.hidden = true
    dom.recordsView.hidden = true
    dom.briefView.hidden = false
    dom.title.textContent = "Review brief"
    setStatusState(dom.briefStatus, "")
    renderBrief(review)
    dom.title.focus()
  }

  function showRecordsView() {
    dom.formView.hidden = true
    dom.briefView.hidden = true
    dom.recordsView.hidden = false
    dom.title.textContent = "Project records"
    setStatusState(dom.recordsStatus, "")
    dom.title.focus()
    loadRecords()
  }

  /* ------------------------------------------------------------------ */
  /* form                                                                */
  /* ------------------------------------------------------------------ */

  async function loadSources() {
    dom.sourceList.replaceChildren(createNote("Loading library…"))

    try {
      const files = []
      let cursor = "0"

      // The library holds at most 40 files, so two pages cover it.
      for (let page = 0; page < 3 && cursor !== null; page++) {
        const data = await apiJson(`/library?cursor=${encodeURIComponent(cursor)}`)
        files.push(...normalizeLibraryFiles(data.files))
        cursor = typeof data.nextCursor === "string" ? data.nextCursor : null
      }

      const documents = files.filter(file => file.kind === "document")

      if (!documents.length) {
        dom.sourceList.replaceChildren(
          createNote("Add design docs, ADRs, or runbooks to your library first; reviews only use library files as evidence.")
        )
        return
      }

      dom.sourceList.replaceChildren(
        ...documents.map(file => {
          const label = document.createElement("label")
          label.className = "review-source"
          const input = document.createElement("input")
          input.type = "checkbox"
          input.name = "reviewSource"
          input.value = file.libraryFileId
          const name = document.createElement("span")
          name.textContent = file.name
          label.append(input, name)
          return label
        })
      )
    } catch (error) {
      dom.sourceList.replaceChildren(createNote(getErrorMessage(error, "Unable to load the library.")))
    }
  }

  async function loadHistory() {
    try {
      const data = await apiJson("/reviews")
      const reviews = normalizeReviewSummaries(data.reviews).slice(0, 6)
      dom.history.hidden = !reviews.length
      dom.historyList.replaceChildren(
        ...reviews.map(summary => {
          const item = document.createElement("li")
          const button = document.createElement("button")
          button.type = "button"
          button.className = "review-history-item"
          const title = document.createElement("span")
          title.textContent = summary.title
          const meta = document.createElement("span")
          meta.className = "review-history-meta"
          meta.textContent = `${READINESS_LABELS[summary.readiness]} · ${summary.findingCount} findings · ${formatRelativeTime(summary.createdAt)}`
          button.append(title, meta)
          button.addEventListener("click", () => openStoredReview(summary.id))
          item.append(button)
          return item
        })
      )
    } catch {
      dom.history.hidden = true
    }
  }

  async function openStoredReview(reviewId, statusElement = dom.status) {
    try {
      const data = await apiJson(reviewPath(reviewId))
      const review = normalizeReview(data.review)
      if (review) showBriefView(review)
    } catch (error) {
      setStatusState(statusElement, getErrorMessage(error, "Unable to open that review."), "error")
    }
  }

  async function submitReview(event) {
    event.preventDefault()
    if (state.running) return

    const sourceFileIds = Array.from(dom.sourceList.querySelectorAll('input[name="reviewSource"]:checked')).map(input => input.value)
    const proposedChange = dom.change.value.trim()
    const intendedOutcome = dom.outcome.value.trim()
    const invalid = !proposedChange ? dom.change : !intendedOutcome ? dom.outcome : null

    if (invalid) {
      setStatusState(dom.status, invalid === dom.change ? "Describe the proposed change." : "Describe the intended outcome.", "error")
      invalid.focus()
      return
    }

    if (!sourceFileIds.length) {
      setStatusState(dom.status, "Select at least one library source.", "error")
      dom.sourceList.querySelector("input")?.focus()
      return
    }

    state.running = true
    dom.submit.disabled = true
    dom.form.setAttribute("aria-busy", "true")
    setStatusState(dom.status, "Retrieving evidence and reviewing the change…")

    try {
      const data = await apiJson("/reviews", {
        method: "POST",
        body: JSON.stringify({ proposedChange, intendedOutcome, constraints: dom.constraints.value.trim(), sourceFileIds })
      })
      const review = normalizeReview(data.review)
      if (!review) throw new Error("The review response was incomplete.")
      dom.form.reset()
      showBriefView(review)
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "The review failed. Please retry."), "error")
    } finally {
      state.running = false
      dom.submit.disabled = false
      dom.form.removeAttribute("aria-busy")
    }
  }

  /* ------------------------------------------------------------------ */
  /* brief                                                               */
  /* ------------------------------------------------------------------ */

  function renderBrief(review, expandFindingId = "") {
    const verdict = document.createElement("section")
    verdict.className = "review-verdict"
    verdict.dataset.readiness = review.readiness
    verdict.setAttribute("aria-label", "Readiness")
    const badge = document.createElement("p")
    badge.className = "review-readiness"
    badge.textContent = READINESS_LABELS[review.readiness]
    const rationale = document.createElement("p")
    rationale.className = "review-rationale"
    rationale.textContent = review.rationale
    const scope = createNote(`Sources: ${review.sourceNames.join(", ") || "none"}`)
    verdict.append(badge, rationale, scope)

    const findings = document.createElement("section")
    findings.setAttribute("aria-labelledby", "reviewFindingsTitle")
    findings.append(createHeading("Findings", "reviewFindingsTitle"))

    if (review.findings.length) {
      const list = document.createElement("ol")
      list.className = "review-findings"
      list.append(...review.findings.map(finding => renderFinding(review, finding)))
      findings.append(list)
    } else {
      findings.append(createNote("No findings were returned."))
    }

    dom.brief.replaceChildren(
      verdict,
      findings,
      ...(review.conflicts.length
        ? [
            renderList(
              "Conflicting sources",
              review.conflicts.map(conflict => `${conflict.description} (${describeCitations(review, conflict.citationIds)})`),
              ""
            )
          ]
        : []),
      renderList("Required tests", review.requiredTests, "No test evidence identified; coverage is unproven."),
      renderList("Observability", review.observability, "No observability evidence identified."),
      renderList("Rollback", review.rollback, "No rollback evidence identified; rollback is unproven."),
      renderList("Missing evidence", review.missingEvidence, "None recorded."),
      renderList("Assumptions", review.assumptions, "None recorded."),
      renderList("Open questions", review.openQuestions, "None recorded."),
      renderList("Next actions", review.nextActions, "None recorded."),
      ...(review.adjustments.length ? [renderList("Server-side corrections", review.adjustments, "")] : [])
    )

    if (expandFindingId) {
      const toggle = dom.brief.querySelector(`[aria-controls="review-evidence-${expandFindingId}"]`)
      toggle?.click()
      toggle?.focus()
    }
  }

  function renderFinding(review, finding) {
    const item = document.createElement("li")
    item.className = "review-finding"
    item.dataset.classification = finding.classification
    item.dataset.withdrawn = String(finding.withdrawn)

    const evidence = getFindingEvidence(review, finding)
    const panelId = `review-evidence-${finding.id}`

    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "review-finding-toggle"
    toggle.setAttribute("aria-expanded", "false")
    toggle.setAttribute("aria-controls", panelId)
    const chip = document.createElement("span")
    chip.className = "review-chip"
    chip.textContent = CLASSIFICATION_LABELS[finding.classification]
    const title = document.createElement("span")
    title.className = "review-finding-title"
    title.textContent = `${finding.id} · ${finding.title}${finding.withdrawn ? " (withdrawn)" : ""}`
    const area = document.createElement("span")
    area.className = "review-finding-area"
    area.textContent = `${finding.areaType}${finding.area ? ` — ${finding.area}` : ""} · ${
      evidence.length ? `${evidence.length} source${evidence.length === 1 ? "" : "s"}` : "no sources cited"
    }${finding.challenges.length ? ` · challenged ${finding.challenges.length}×` : ""}`
    toggle.append(chip, title, area)

    const panel = document.createElement("div")
    panel.id = panelId
    panel.className = "review-finding-panel"
    panel.hidden = true

    if (finding.detail) {
      const detail = document.createElement("p")
      detail.textContent = finding.detail
      panel.append(detail)
    }

    if (evidence.length) {
      panel.append(
        ...evidence.map(source => {
          const figure = document.createElement("figure")
          figure.className = "review-excerpt"
          const quote = document.createElement("blockquote")
          quote.textContent = source.sourceDeleted ? "This source was deleted after the review; its excerpt was removed." : source.snippet
          const caption = document.createElement("figcaption")
          caption.textContent = `${source.ref} · ${source.fileName}`
          figure.append(quote, caption)
          return figure
        })
      )
    } else {
      panel.append(createNote("No retrieved source supports this finding."))
    }

    finding.adjustments.forEach(adjustment => panel.append(createNote(`Correction: ${adjustment}`)))

    if (finding.challenges.length) {
      panel.append(renderChallengeHistory(review, finding))
    }

    if (!finding.withdrawn) {
      panel.append(renderChallengeForm(review, finding))
    }

    toggle.addEventListener("click", () => {
      const expanded = toggle.getAttribute("aria-expanded") === "true"
      toggle.setAttribute("aria-expanded", String(!expanded))
      panel.hidden = expanded
    })

    item.append(toggle, panel, renderDispositionControls(review, finding))
    return item
  }

  function renderDispositionControls(review, finding) {
    const group = document.createElement("div")
    group.className = "review-disposition"
    group.setAttribute("role", "group")
    group.setAttribute("aria-label", `Disposition for ${finding.id}`)

    const kindLabel = document.createElement("label")
    kindLabel.className = "review-record-kind"
    const kindText = document.createElement("span")
    kindText.textContent = "Save as"
    const kindSelect = document.createElement("select")
    kindSelect.setAttribute("aria-label", `Save ${finding.id} as`)
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

    DISPOSITIONS.forEach(option => {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "secondary-button"
      button.textContent = option.label
      button.dataset.disposition = option.value
      button.setAttribute("aria-pressed", String(finding.disposition === option.value))
      button.disabled = finding.withdrawn && option.value === "accepted"
      button.addEventListener("click", () => setDisposition(review, finding, option.value, button, kindSelect.value))
      group.append(button)
    })

    group.append(kindLabel)
    return group
  }

  function renderChallengeHistory(review, finding) {
    const section = document.createElement("div")
    section.className = "review-finding-panel"
    const heading = document.createElement("h4")
    heading.className = "review-section-title"
    heading.textContent = "Challenge history"
    section.append(heading)

    finding.challenges.forEach(challenge => {
      const entry = document.createElement("div")
      entry.className = "review-history-entry"
      entry.dataset.changed = String(challenge.conclusionChanged)
      const summary = document.createElement("p")
      summary.textContent = `${challenge.id} · ${CHALLENGE_OUTCOME_LABELS[challenge.outcome]} · conclusion ${
        challenge.conclusionChanged ? "changed" : "unchanged"
      } · ${formatRelativeTime(challenge.createdAt)}`
      entry.append(summary)
      if (challenge.reason) entry.append(createNote(`Challenge: ${challenge.reason}`))
      const rationale = document.createElement("p")
      rationale.textContent = challenge.rationale
      entry.append(rationale)
      entry.append(createNote(`Counter-evidence: ${describeCitations(review, challenge.counterEvidenceIds)}`))
      if (challenge.conclusionChanged) {
        entry.append(createNote(`Before: ${challenge.beforeTitle}`))
        entry.append(createNote(`After: ${challenge.afterTitle || "withdrawn"}`))
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
    const label = document.createElement("label")
    label.className = "settings-field"
    const labelText = document.createElement("span")
    labelText.textContent = "Why do you doubt this? (optional)"
    const reason = document.createElement("textarea")
    reason.rows = 2
    reason.maxLength = 500
    label.append(labelText, reason)
    const actions = document.createElement("div")
    actions.className = "settings-actions"
    const submit = document.createElement("button")
    submit.type = "submit"
    submit.className = "secondary-button"
    submit.textContent = "Challenge this conclusion"
    actions.append(submit)
    form.append(label, actions)
    form.addEventListener("submit", event => {
      event.preventDefault()
      challengeFinding(review, finding, reason.value.trim(), submit)
    })
    return form
  }

  async function challengeFinding(review, finding, reason, button) {
    button.disabled = true
    setStatusState(dom.briefStatus, `Searching the review's sources for counter-evidence to ${finding.id}…`)

    try {
      const data = await apiJson(challengePath(review.id, finding.id), {
        method: "POST",
        body: JSON.stringify({ reason })
      })
      const updated = normalizeReview(data.review)
      if (!updated) throw new Error("The challenge response was incomplete.")
      const outcome = data.challenge?.outcome
      state.review = updated
      renderBrief(updated, finding.id)
      setStatusState(
        dom.briefStatus,
        `${finding.id} challenge: ${CHALLENGE_OUTCOME_LABELS[outcome] || "recorded"}. The conclusion ${
          data.challenge?.conclusionChanged ? "changed" : "did not change"
        }.`,
        "success"
      )
    } catch (error) {
      button.disabled = false
      button.focus()
      setStatusState(dom.briefStatus, getErrorMessage(error, "The challenge failed. Please retry."), "error")
    }
  }

  async function setDisposition(review, finding, disposition, button, recordAs) {
    const buttons = Array.from(button.parentElement.querySelectorAll("button"))
    const wasDisabled = buttons.map(candidate => candidate.disabled)
    buttons.forEach(candidate => (candidate.disabled = true))

    try {
      const data = await apiJson(findingPath(review.id, finding.id), {
        method: "POST",
        body: JSON.stringify({ disposition, recordAs })
      })
      const updated = normalizeReview(data.review)
      if (updated) state.review = updated
      finding.disposition = disposition
      buttons.forEach(candidate => candidate.setAttribute("aria-pressed", String(candidate.dataset.disposition === disposition)))
      const kind = RECORD_KINDS.find(option => option.value === recordAs)?.label.toLowerCase() || "finding"
      setStatusState(
        dom.briefStatus,
        disposition === "accepted" ? `${finding.id} accepted and saved to project records as a ${kind}.` : `${finding.id} marked ${disposition}.`,
        "success"
      )
    } catch (error) {
      setStatusState(dom.briefStatus, getErrorMessage(error, "Unable to save the disposition."), "error")
    } finally {
      buttons.forEach((candidate, index) => (candidate.disabled = wasDisabled[index]))
      // Disabling the focused button drops focus to <body>; put it back.
      button.focus()
    }
  }

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
      setStatusState(dom.briefStatus, "Review brief exported as Markdown.", "success")
    } catch (error) {
      setStatusState(dom.briefStatus, getErrorMessage(error, "Export failed."), "error")
    }
  }

  async function loadRecords() {
    dom.recordsList.replaceChildren(createNote("Loading project records…"))

    try {
      const records = normalizeContextRecords(await apiJson("/context?includeContent=true"))

      if (!records.length) {
        dom.recordsList.replaceChildren(createNote("No records yet. Accept a finding in a review to save it here."))
        return
      }

      const kinds = Object.keys(CONTEXT_KIND_LABELS)
      const groups = [...new Set(records.map(record => record.kind))].sort((left, right) => kinds.indexOf(left) - kinds.indexOf(right))

      dom.recordsList.replaceChildren(
        ...groups.map(kind => {
          const section = document.createElement("section")
          const id = `records-${kind}`
          section.setAttribute("aria-labelledby", id)
          section.append(createHeading(CONTEXT_KIND_LABELS[kind] || kind, id))
          const list = document.createElement("ul")
          list.className = "review-findings"
          list.append(...records.filter(record => record.kind === kind).map(renderRecord))
          section.append(list)
          return section
        })
      )
    } catch (error) {
      dom.recordsList.replaceChildren(createNote(getErrorMessage(error, "Unable to load project records.")))
    }
  }

  function renderRecord(record) {
    const item = document.createElement("li")
    item.className = "review-record"
    const title = document.createElement("h4")
    title.textContent = record.title
    const content = document.createElement("p")
    content.textContent = record.content
    item.append(
      title,
      content,
      createNote(`${record.sourceNames.length ? `Sources: ${record.sourceNames.join(", ")}` : "No live sources"} · ${formatRelativeTime(record.updatedAt)}`)
    )

    if (record.reviewId) {
      const open = document.createElement("button")
      open.type = "button"
      open.className = "secondary-button"
      open.textContent = `Open review (${record.findingId})`
      open.addEventListener("click", () => openStoredReview(record.reviewId, dom.recordsStatus))
      item.append(open)
    }

    return item
  }

  function describeCitations(review, chunkIds) {
    return (
      chunkIds
        .map(chunkId => review.evidence.find(item => item.chunkId === chunkId))
        .filter(Boolean)
        .map(item => `${item.ref} ${item.fileName}`)
        .join("; ") || "no sources"
    )
  }

  function renderList(title, items, emptyText) {
    const section = document.createElement("section")
    const id = `review-section-${title.toLowerCase().replace(/[^a-z]+/g, "-")}`
    section.setAttribute("aria-labelledby", id)
    section.append(createHeading(title, id))

    if (!items.length) {
      section.append(createNote(emptyText))
      return section
    }

    const list = document.createElement("ul")
    list.className = "review-list"
    list.append(
      ...items.map(text => {
        const item = document.createElement("li")
        item.textContent = text
        return item
      })
    )
    section.append(list)
    return section
  }

  function createHeading(text, id) {
    const heading = document.createElement("h3")
    heading.className = "review-section-title"
    heading.id = id
    heading.textContent = text
    return heading
  }

  function createNote(text) {
    const note = document.createElement("p")
    note.className = "settings-note"
    note.textContent = text
    return note
  }
})()
