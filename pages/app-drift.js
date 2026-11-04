// Drift checks: the second review-workspace workflow. It registers its start
// and run views as centres of the review panel through window.LytaWorkspaceUi,
// so the evidence inspector, mobile sheet, and DOM builders stay those of
// pages/app-review.js. Typed helpers live in pages-src/app-drift-core.ts. All
// untrusted text goes through textContent.
;(() => {
  const { formatRelativeTime, setStatusState, getErrorMessage, apiJson, extractResponseErrorMessage, announce } = window.LytaCore

  const {
    COMPARISON_TYPE,
    ROLES,
    ROLE_LABELS,
    RULES,
    CONFIDENCE_LABELS,
    DIFF_LABELS,
    DISPOSITIONS,
    normalizeComparison,
    normalizeRun,
    normalizeSummaries,
    getEvidence,
    describeCounterpart,
    dispositionOf,
    buildSelection,
    buildRunAnnouncement,
    buildDispositionAnnouncement,
    driftPath,
    runsPath,
    runPath,
    dispositionsPath
  } = window.LytaDrift

  const workspace = window.LytaWorkspaceUi
  const { appendMeta, createButton, createCallout, createHeading, createList, createListNote, createNote, createParagraph, renderListSection, truncate } =
    workspace.builders
  const MOBILE_QUERY = window.matchMedia("(max-width: 980px)")

  const $ = id => document.getElementById(id)

  const dom = {
    openDrift: $("openDrift"),
    sidebarDrift: $("sidebarDrift"),
    driftCount: $("driftCount"),
    newButton: $("driftNew"),
    rerunButton: $("driftRerun"),
    exportButton: $("driftExport"),
    startView: $("driftStartView"),
    form: $("driftForm"),
    scope: $("driftScope"),
    roleSummary: $("driftRoleSummary"),
    sourceList: $("driftSourceList"),
    addSources: $("driftAddSources"),
    rules: $("driftRules"),
    submit: $("driftSubmit"),
    runView: $("driftRunView"),
    run: $("driftRun"),
    // Shared with app-review.js: the panel, its status line, and the evidence inspector.
    panel: workspace.dom.panel,
    panelTitle: workspace.dom.panelTitle,
    status: workspace.dom.status,
    evidenceTitle: workspace.dom.evidenceTitle,
    evidenceBody: workspace.dom.evidenceBody
  }

  const state = {
    comparisons: [],
    comparison: null,
    run: null,
    selectedKey: "",
    // Set while the start form is re-running an existing comparison.
    rerunOf: null,
    roleChoices: new Map(),
    running: false,
    lastRequest: null
  }

  workspace.registerCentre("drift-start", { element: dom.startView, renderEvidence: renderStartEvidence })
  workspace.registerCentre("drift-run", { element: dom.runView, renderEvidence })

  dom.openDrift.addEventListener("click", () => {
    workspace.closeSidebarIfMobile()
    workspace.setView("review")
    showStart()
  })
  dom.newButton.addEventListener("click", () => showStart())
  dom.rerunButton.addEventListener("click", () => state.run && showStart({ rerun: true }))
  dom.exportButton.addEventListener("click", exportRun)
  dom.addSources.addEventListener("click", () => workspace.openLibraryPicker())
  dom.form.addEventListener("submit", submitDrift)
  dom.sourceList.addEventListener("change", event => {
    const select = event.target.closest("select[data-file-id]")
    if (!select) return
    state.roleChoices.set(select.dataset.fileId, select.value)
    renderRoleSummary()
  })

  document.addEventListener("lyta:centre-changed", event => {
    const centre = event.detail?.centre
    dom.newButton.hidden = centre !== "drift-run"
    dom.rerunButton.hidden = centre !== "drift-run" || !state.run
    dom.exportButton.hidden = centre !== "drift-run" || !state.run
    renderSidebar()
  })
  document.addEventListener("lyta:sources-loaded", renderSourceOptions)
  document.addEventListener("lyta:workspace-ready", () => {
    state.comparison = null
    state.run = null
    loadComparisons()
  })

  /* ------------------------------------------------------------------ */
  /* sidebar                                                             */
  /* ------------------------------------------------------------------ */

  async function loadComparisons() {
    try {
      state.comparisons = normalizeSummaries((await apiJson("/drift")).comparisons)
    } catch {
      state.comparisons = []
    }
    renderSidebar()
  }

  function renderSidebar() {
    dom.driftCount.textContent = `${state.comparisons.length} check${state.comparisons.length === 1 ? "" : "s"}`

    if (!state.comparisons.length) {
      dom.sidebarDrift.replaceChildren(createListNote("No drift checks yet. Use Check drift to compare a spec, a design, and code."))
      return
    }

    const showing = !dom.runView.hidden && state.comparison
    dom.sidebarDrift.replaceChildren(
      ...state.comparisons.slice(0, 8).map(summary => {
        const item = document.createElement("li")
        const button = document.createElement("button")
        button.type = "button"
        button.className = "sidebar-list-button"
        if (showing && state.comparison.id === summary.id) button.setAttribute("aria-current", "true")
        const title = document.createElement("span")
        title.textContent = summary.title
        const meta = document.createElement("span")
        meta.className = "sidebar-list-meta"
        meta.textContent = `${summary.runCount} run${summary.runCount === 1 ? "" : "s"}`
        button.append(title, meta)
        button.setAttribute(
          "aria-label",
          `${summary.title}. ${summary.runCount} runs, ${summary.findingCount} findings in the latest run.`
        )
        button.addEventListener("click", () => {
          workspace.closeSidebarIfMobile()
          workspace.setView("review")
          openComparison(summary.id)
        })
        item.append(button)
        return item
      })
    )
  }

  /* ------------------------------------------------------------------ */
  /* start form                                                          */
  /* ------------------------------------------------------------------ */

  function showStart({ rerun = false } = {}) {
    state.rerunOf = rerun && state.comparison && state.run ? { comparison: state.comparison, run: state.run } : null
    state.roleChoices = new Map((state.rerunOf?.run.sources || []).map(source => [source.fileId, source.role]))

    workspace.setCentre("drift-start", {
      title: state.rerunOf ? "Re-run drift check" : "Check drift",
      eyebrow: state.rerunOf ? truncate(state.rerunOf.comparison.scope, 90) : "Drift detection"
    })

    // Scope and rules are fixed for a comparison so finding keys stay comparable across runs.
    dom.scope.value = state.rerunOf ? state.rerunOf.comparison.scope : dom.scope.value
    dom.scope.readOnly = Boolean(state.rerunOf)
    dom.rules.disabled = Boolean(state.rerunOf)
    dom.submit.textContent = state.rerunOf ? "Re-run against these sources" : "Run drift check"
    if (state.rerunOf) {
      const ruleSet = new Set(state.rerunOf.run.rules.length ? state.rerunOf.run.rules : Object.keys(RULES))
      dom.rules.querySelectorAll('input[name="driftRule"]').forEach(input => {
        input.checked = ruleSet.has(input.value)
      })
    }

    renderSourceOptions()
    workspace.renderEvidence()
    ;(state.rerunOf ? dom.sourceList.querySelector("select") || dom.panelTitle : dom.scope).focus()
  }

  /** Back to the form after a failure, keeping the scope, roles, and re-run target. */
  function returnToStart() {
    workspace.setCentre("drift-start", {
      title: state.rerunOf ? "Re-run drift check" : "Check drift",
      eyebrow: state.rerunOf ? truncate(state.rerunOf.comparison.scope, 90) : "Drift detection"
    })
    renderSourceOptions()
    workspace.renderEvidence()
    dom.scope.focus()
  }

  function renderSourceOptions() {
    const documents = workspace.getDocuments()

    if (!documents.length) {
      dom.sourceList.replaceChildren(
        createNote("No documents in the library yet. Add a PRD, a design doc, and a code export; drift checks only compare library files.")
      )
      renderRoleSummary()
      return
    }

    // Same-name files are versions of one document: show when each was
    // imported and which is newest (the library lists newest first).
    const seenNames = new Set()
    const duplicateNames = new Set(documents.map(file => file.name).filter((name, index, names) => names.indexOf(name) !== index))

    dom.sourceList.replaceChildren(
      ...documents.map(file => {
        const isNewest = !seenNames.has(file.name)
        seenNames.add(file.name)
        const row = document.createElement("label")
        row.className = "drift-role-row"
        const name = document.createElement("span")
        name.className = "drift-role-file"
        name.textContent = duplicateNames.has(file.name)
          ? `${file.name} · imported ${formatImported(file.createdAt)}${isNewest ? " (newest)" : " (older version)"}`
          : file.name
        const select = document.createElement("select")
        select.dataset.fileId = file.libraryFileId
        select.setAttribute("aria-label", `Role for ${file.name}`)
        select.append(
          ...[["", "Not compared"], ...ROLES.map(role => [role, ROLE_LABELS[role]])].map(([value, label]) => {
            const option = document.createElement("option")
            option.value = value
            option.textContent = label
            return option
          })
        )
        select.value = state.roleChoices.get(file.libraryFileId) || ""
        row.append(name, select)
        return row
      })
    )
    renderRoleSummary()
  }

  function currentSelection() {
    return buildSelection([...state.roleChoices].map(([fileId, role]) => ({ fileId, role })))
  }

  function renderRoleSummary() {
    const { sources } = currentSelection()
    dom.roleSummary.textContent = ROLES.map(role => `${ROLE_LABELS[role]}: ${sources[role].length}`).join(" · ")
  }

  function submitDrift(event) {
    event.preventDefault()
    if (state.running) return

    const scope = dom.scope.value.trim()
    const selection = currentSelection()
    const rules = Array.from(dom.rules.querySelectorAll('input[name="driftRule"]:checked')).map(input => input.value)

    if (!scope) {
      setStatusState(dom.status, "Describe the scope to check.", "error")
      dom.scope.focus()
      return
    }

    if (selection.error) {
      setStatusState(dom.status, selection.error, "error")
      ;(dom.sourceList.querySelector("select") || dom.addSources).focus()
      return
    }

    if (!rules.length) {
      setStatusState(dom.status, "Select at least one drift rule.", "error")
      dom.rules.querySelector("input")?.focus()
      return
    }

    const request = state.rerunOf
      ? { path: runsPath(state.rerunOf.comparison.id), body: { sources: selection.sources }, scope }
      : { path: "/drift", body: { comparisonType: COMPARISON_TYPE, scope, sources: selection.sources, rules }, scope }
    runDrift(request)
  }

  async function runDrift(request) {
    state.running = true
    state.lastRequest = request
    state.run = null
    dom.submit.disabled = true
    dom.panel.setAttribute("aria-busy", "true")
    workspace.setCentre("drift-run", { title: "Checking drift…", eyebrow: truncate(request.scope, 90) })
    dom.run.replaceChildren(renderLoading())
    workspace.renderEvidence()
    setStatusState(dom.status, "Retrieving evidence for each role and checking it against the drift rules.")
    dom.panelTitle.focus()

    try {
      const data = await apiJson(request.path, { method: "POST", body: JSON.stringify(request.body) })
      const comparison = normalizeComparison(data.comparison)
      const run = normalizeRun(data.run)
      if (!comparison || !run) throw new Error("The drift response was incomplete.")
      state.running = false
      showRun(comparison, run)
      announce(buildRunAnnouncement(run))
      dom.panelTitle.focus()
      loadComparisons()
    } catch (error) {
      state.running = false
      renderFailure(getErrorMessage(error, "The drift check failed. Please retry."))
    } finally {
      state.running = false
      dom.submit.disabled = false
      dom.panel.removeAttribute("aria-busy")
    }
  }

  function renderLoading() {
    const block = document.createElement("div")
    block.className = "review-loading"
    const skeleton = document.createElement("div")
    skeleton.className = "skeleton-lines"
    skeleton.setAttribute("aria-hidden", "true")
    skeleton.append(document.createElement("span"), document.createElement("span"), document.createElement("span"))
    block.append(
      createNote("Searching the specification, architecture, and implementation sources in turn, then validating every finding against them…"),
      skeleton
    )
    return block
  }

  function renderFailure(message) {
    dom.panelTitle.textContent = "Drift check failed"
    const callout = createCallout("danger", "The drift check did not complete", message)
    callout.append(createNote("Nothing was saved, and earlier runs are unchanged. Your scope and role choices are kept."))
    const actions = document.createElement("div")
    actions.className = "record-actions"
    const retry = createButton("Retry", "primary-button", () => state.lastRequest && runDrift(state.lastRequest))
    const edit = createButton("Edit the selection", "secondary-button", returnToStart)
    actions.append(retry, edit)
    callout.append(actions)
    dom.run.replaceChildren(callout)
    setStatusState(dom.status, message, "error")
    announce(`Drift check failed. ${message}`, "assertive")
    retry.focus()
  }

  /* ------------------------------------------------------------------ */
  /* run view (centre panel)                                             */
  /* ------------------------------------------------------------------ */

  async function openComparison(comparisonId, runId = "") {
    try {
      const data = await apiJson(runId ? runPath(comparisonId, runId) : driftPath(comparisonId))
      const comparison = normalizeComparison(data.comparison)
      const run = normalizeRun(data.run)
      if (!comparison || !run) throw new Error("That drift check could not be read.")
      showRun(comparison, run)
      dom.panelTitle.focus()
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Unable to open that drift check."), "error")
    }
  }

  function showRun(comparison, run) {
    state.comparison = comparison
    state.run = run
    if (!run.findings.some(finding => finding.key === state.selectedKey)) {
      state.selectedKey = run.findings[0]?.key || ""
    }
    workspace.setCentre("drift-run", { title: `Drift run ${run.number}`, eyebrow: truncate(comparison.scope, 90) })
    renderRun()
    workspace.renderEvidence()
  }

  function renderRun() {
    const { comparison, run } = state
    if (!comparison || !run) return

    const summary = document.createElement("section")
    summary.className = "drift-summary"
    summary.setAttribute("aria-label", "Run summary")
    summary.append(
      createParagraph(run.summary),
      createNote(
        `Run ${run.number} of ${comparison.runs.length} · ${formatRelativeTime(run.createdAt)} · ${
          run.modelVersion ? `model ${run.modelVersion}` : "no model call"
        } · policy ${run.policyVersion}`
      )
    )

    const sections = [summary, renderRunHistory(), renderDiffSummary(), renderSources(), renderCoverage()]

    const findings = document.createElement("section")
    findings.setAttribute("aria-labelledby", "driftFindingsTitle")
    findings.append(createHeading("Findings", "driftFindingsTitle"))
    findings.append(createNote("Select a finding to inspect the claim, its counterpart, and the exact passages, then record a disposition."))

    if (run.findings.length) {
      const list = document.createElement("ol")
      list.className = "review-findings"
      list.append(...run.findings.map(renderFindingRow))
      findings.append(list)
    } else {
      findings.append(createNote("No drift was found in the supplied evidence for the selected rules."))
    }
    sections.push(findings)

    if (run.resolved.length) {
      const resolved = document.createElement("section")
      resolved.setAttribute("aria-labelledby", "driftResolvedTitle")
      resolved.append(
        createHeading("Resolved since the previous run", "driftResolvedTitle"),
        createNote("Reported by the previous run but not this one. That is not proof the drift was fixed.")
      )
      const list = document.createElement("ul")
      list.className = "review-findings"
      list.append(
        ...run.resolved.map(item => {
          const entry = document.createElement("li")
          entry.className = "drift-resolved"
          const badge = createBadge("resolved")
          const text = document.createElement("span")
          const disposition = dispositionOf(comparison, item.key).disposition
          text.textContent = `${RULES[item.rule].code} · ${item.subject}: ${item.claim} (last seen in run ${item.lastSeenRunNumber}${
            disposition !== "undecided" ? `; ${labelFor(disposition).toLowerCase()}` : ""
          })`
          entry.append(badge, text)
          return entry
        })
      )
      resolved.append(list)
      sections.push(resolved)
    }

    if (run.adjustments.length) {
      sections.push(renderListSection("Server-side corrections", run.adjustments, ""))
    }

    dom.run.replaceChildren(...sections)
  }

  function renderRunHistory() {
    const { comparison, run } = state
    const section = document.createElement("section")
    section.setAttribute("aria-labelledby", "driftHistoryTitle")
    section.append(createHeading("Run history", "driftHistoryTitle"))
    const group = document.createElement("div")
    group.className = "mode-selector drift-run-history"
    group.setAttribute("role", "group")
    group.setAttribute("aria-label", "Open an earlier run")
    group.append(
      ...comparison.runs.map(summary => {
        const button = createButton(`Run ${summary.number}`, "mode-button", () => openComparison(comparison.id, summary.id))
        button.setAttribute("aria-pressed", String(summary.id === run.id))
        button.setAttribute(
          "aria-label",
          `Run ${summary.number}, ${formatRelativeTime(summary.createdAt)}: ${summary.findingCount} findings, ${summary.newCount} new, ${summary.resolvedCount} resolved.`
        )
        return button
      })
    )
    section.append(group)
    return section
  }

  function renderDiffSummary() {
    const { run } = state
    const counts = {
      new: run.findings.filter(finding => finding.diffStatus === "new").length,
      unchanged: run.findings.filter(finding => finding.diffStatus === "unchanged").length,
      resolved: run.resolved.length
    }
    const section = document.createElement("section")
    section.setAttribute("aria-labelledby", "driftDiffTitle")
    section.append(
      createHeading(run.previousRunNumber ? `Changes since run ${run.previousRunNumber}` : "First run", "driftDiffTitle")
    )
    const badges = document.createElement("p")
    badges.className = "drift-diff-summary"
    for (const status of ["new", "unchanged", "resolved"]) {
      badges.append(createBadge(status, `${counts[status]} ${DIFF_LABELS[status].toLowerCase()}`))
    }
    section.append(badges)
    if (!run.previousRunNumber) section.append(createNote("Every finding is new. Re-run after the sources change to see what was resolved."))
    return section
  }

  function renderSources() {
    const { run } = state
    const section = document.createElement("section")
    section.setAttribute("aria-labelledby", "driftSourcesTitle")
    section.append(createHeading("Sources compared", "driftSourcesTitle"))
    const wrapper = document.createElement("div")
    wrapper.className = "drift-table-wrap"
    const table = document.createElement("table")
    table.className = "drift-sources-table"
    const head = document.createElement("tr")
    for (const label of ["Role", "File", "Version", "Imported"]) {
      const cell = document.createElement("th")
      cell.scope = "col"
      cell.textContent = label
      head.append(cell)
    }
    const thead = document.createElement("thead")
    thead.append(head)
    const tbody = document.createElement("tbody")
    tbody.append(
      ...run.sources.map(source => {
        const row = document.createElement("tr")
        // Versions are content hashes; a short prefix identifies one, like a short commit id.
        const version = document.createElement("code")
        version.textContent = shortVersion(source.sourceVersionId)
        version.title = source.sourceVersionId
        const cells = [
          ROLE_LABELS[source.role],
          source.superseded ? `${source.fileName} (a newer version is in the library)` : source.fileName,
          version,
          source.importedAt ? formatImported(source.importedAt) : "unknown"
        ]
        row.append(
          ...cells.map(value => {
            const cell = document.createElement("td")
            cell.append(value)
            return cell
          })
        )
        return row
      })
    )
    table.append(thead, tbody)
    wrapper.append(table)
    section.append(wrapper)
    return section
  }

  function renderCoverage() {
    const { run } = state
    const section = renderListSection(
      "Evidence coverage",
      run.coverage.map(
        item =>
          `${ROLE_LABELS[item.role]}: ${item.passageCount} passage${item.passageCount === 1 ? "" : "s"} from ${item.sourceCount} source${
            item.sourceCount === 1 ? "" : "s"
          }${item.sourcesWithoutPassages.length ? `; nothing matched in ${item.sourcesWithoutPassages.join(", ")}` : ""}`
      ),
      "No coverage recorded."
    )
    section.append(
      createNote("LYTA only compares these retrieved passages. Something not found in them may still exist elsewhere in the project.")
    )
    return section
  }

  function renderFindingRow(finding) {
    const item = document.createElement("li")
    const button = document.createElement("button")
    button.type = "button"
    button.className = "review-finding-select drift-finding-select"
    button.dataset.findingKey = finding.key
    button.dataset.counterpart = finding.counterpart.kind
    button.setAttribute("aria-pressed", String(finding.key === state.selectedKey))
    button.setAttribute("aria-controls", "evidencePanel")

    const rule = document.createElement("span")
    rule.className = "review-chip"
    rule.textContent = RULES[finding.rule].code
    rule.title = RULES[finding.rule].title
    const title = document.createElement("span")
    title.className = "review-finding-title"
    title.textContent = `${finding.id} · ${finding.subject}`
    const meta = document.createElement("span")
    meta.className = "review-finding-area"
    const disposition = dispositionOf(state.comparison, finding.key).disposition
    meta.textContent = [
      RULES[finding.rule].title,
      describeCounterpart(finding).label,
      CONFIDENCE_LABELS[finding.confidence],
      disposition !== "undecided" ? labelFor(disposition) : ""
    ]
      .filter(Boolean)
      .join(" · ")
    button.append(rule, createBadge(finding.diffStatus), title, meta)
    button.addEventListener("click", () => selectFinding(finding.key, button))
    item.append(button)
    return item
  }

  function selectFinding(key, trigger) {
    state.selectedKey = key
    dom.run.querySelectorAll(".drift-finding-select").forEach(button => {
      button.setAttribute("aria-pressed", String(button.dataset.findingKey === key))
    })
    workspace.renderEvidence()

    const finding = state.run?.findings.find(candidate => candidate.key === key)
    if (finding) announce(`Showing ${finding.id}: ${describeCounterpart(finding).label}, ${CONFIDENCE_LABELS[finding.confidence].toLowerCase()}.`)
    if (MOBILE_QUERY.matches) workspace.openEvidenceSheet(trigger)
  }

  /* ------------------------------------------------------------------ */
  /* evidence inspector                                                  */
  /* ------------------------------------------------------------------ */

  function renderStartEvidence() {
    dom.evidenceTitle.textContent = "Evidence"
    dom.evidenceBody.replaceChildren(
      createNote("Give each file a role and run the check. Each finding's claim, counterpart, and source passages appear here.")
    )
  }

  function renderEvidence() {
    const { comparison, run } = state
    const finding = run?.findings.find(candidate => candidate.key === state.selectedKey)

    if (!run || !finding) {
      dom.evidenceTitle.textContent = "Evidence"
      dom.evidenceBody.replaceChildren(
        createNote(
          state.running
            ? "Evidence appears here once the drift check is ready."
            : run
              ? "Select a finding to see its claim, its counterpart, and the exact passages."
              : "Open a drift check from the sidebar to inspect its evidence."
        )
      )
      return
    }

    dom.evidenceTitle.textContent = `Evidence for ${finding.id}`
    const heading = document.createElement("h3")
    heading.textContent = finding.subject
    const parts = [heading, createNote(`${RULES[finding.rule].code} ${RULES[finding.rule].title} · key ${finding.key}`)]

    const claim = document.createElement("section")
    claim.setAttribute("aria-labelledby", "driftClaimTitle")
    claim.append(
      createHeading(finding.claimRole ? `Claim · ${ROLE_LABELS[finding.claimRole]}` : "Claim", "driftClaimTitle"),
      createParagraph(finding.claim)
    )
    if (finding.detail) claim.append(createNote(finding.detail))
    const claimEvidence = getEvidence(run, finding.claimCitationIds)
    claim.append(...claimEvidence.map(renderEvidenceCard))
    if (!claimEvidence.length && finding.rule !== "stale-or-missing-source") {
      claim.append(createCallout("warning", "Claim passage unavailable", "The passage this claim cites is no longer stored."))
    }
    parts.push(claim)

    const counterpartState = describeCounterpart(finding)
    const counterpart = document.createElement("section")
    counterpart.setAttribute("aria-labelledby", "driftCounterpartTitle")
    counterpart.append(createHeading("Counterpart", "driftCounterpartTitle"))
    const stateBlock = document.createElement("div")
    stateBlock.className = "evidence-state"
    stateBlock.dataset.state = counterpartState.state
    const stateLabel = document.createElement("strong")
    stateLabel.textContent = counterpartState.label
    stateBlock.append(stateLabel, createParagraph(finding.counterpart.description || counterpartState.description))
    if (finding.counterpart.description) stateBlock.append(createNote(counterpartState.description))
    counterpart.append(stateBlock, ...getEvidence(run, finding.counterpart.citationIds).map(renderEvidenceCard))
    parts.push(counterpart)

    const confidence = document.createElement("section")
    confidence.setAttribute("aria-labelledby", "driftConfidenceTitle")
    confidence.append(createHeading("Confidence", "driftConfidenceTitle"), createParagraph(`${CONFIDENCE_LABELS[finding.confidence]}. ${finding.confidenceReason}`))
    finding.adjustments.forEach(adjustment => confidence.append(createNote(`Server correction: ${adjustment}`)))
    parts.push(confidence, renderDispositionControls(comparison, run, finding))

    dom.evidenceBody.replaceChildren(...parts)
  }

  function renderEvidenceCard(item) {
    const card = document.createElement("article")
    card.className = "evidence-card"
    const heading = document.createElement("h4")
    heading.textContent = `${item.ref} · ${item.fileName}`
    const source = state.run.sources.find(candidate => candidate.fileId === item.fileId)
    const meta = document.createElement("dl")
    meta.className = "evidence-meta"
    appendMeta(meta, "Role", ROLE_LABELS[item.role])
    appendMeta(meta, "File id", item.fileId, true)
    if (source?.sourceVersionId) appendMeta(meta, "Version", source.sourceVersionId, true)
    appendMeta(meta, "Passage", item.chunkId, true)
    appendMeta(meta, "Retrieval", `${ROLE_LABELS[item.role]} search, rank ${item.rank} of ${item.retrievalSize} · policy ${state.run.policyVersion}.${item.role}`)
    const excerpt = document.createElement("blockquote")
    excerpt.className = "evidence-excerpt"
    excerpt.textContent = item.sourceDeleted ? "This source was deleted after the run, so its excerpt is no longer stored." : item.snippet
    card.append(heading, meta, createNote(item.sourceDeleted ? "Excerpt removed" : "Excerpt (start of the retrieved passage)"), excerpt)
    return card
  }

  function renderDispositionControls(comparison, run, finding) {
    const current = dispositionOf(comparison, finding.key)
    const section = document.createElement("section")
    section.setAttribute("aria-labelledby", "driftDispositionTitle")
    section.append(createHeading("Disposition", "driftDispositionTitle"))

    const noteLabel = document.createElement("label")
    noteLabel.className = "settings-field"
    const noteText = document.createElement("span")
    noteText.textContent = "Note (optional)"
    const note = document.createElement("textarea")
    note.id = "driftDispositionNote"
    note.rows = 2
    note.maxLength = 500
    note.value = current.note
    noteLabel.append(noteText, note)

    const group = document.createElement("div")
    group.className = "review-disposition"
    group.setAttribute("role", "group")
    group.setAttribute("aria-label", `Disposition for ${finding.id}`)
    DISPOSITIONS.forEach(option => {
      const button = createButton(option.label, "secondary-button", () => setDisposition(comparison, run, finding, option.value, note.value.trim()))
      button.dataset.disposition = option.value
      button.setAttribute("aria-pressed", String(current.disposition === option.value))
      group.append(button)
    })

    section.append(noteLabel, group, createNote("Kept for this finding's key on every later run of this comparison."))

    if (current.history.length > 1) {
      section.append(
        createList(
          current.history.map(entry => `${labelFor(entry.disposition)} · ${formatRelativeTime(entry.at)}${entry.note ? ` — ${entry.note}` : ""}`)
        )
      )
    }

    return section
  }

  async function setDisposition(comparison, run, finding, disposition, note) {
    try {
      const data = await apiJson(dispositionsPath(comparison.id), {
        method: "POST",
        body: JSON.stringify({ runId: run.id, findingKey: finding.key, disposition, note })
      })
      const updated = normalizeComparison(data.comparison)
      if (!updated) throw new Error("The disposition response was incomplete.")
      state.comparison = updated
      renderRun()
      workspace.renderEvidence()
      dom.evidenceBody.querySelector(`[data-disposition="${disposition}"]`)?.focus()
      const message = buildDispositionAnnouncement(finding, disposition)
      setStatusState(dom.status, message, "success")
      announce(message)
    } catch (error) {
      const message = getErrorMessage(error, "Unable to save the disposition.")
      setStatusState(dom.status, message, "error")
      announce(message, "assertive")
    }
  }

  /* ------------------------------------------------------------------ */
  /* export + small builders                                             */
  /* ------------------------------------------------------------------ */

  async function exportRun() {
    const { comparison, run } = state
    if (!comparison || !run) return

    try {
      const response = await fetch(runPath(comparison.id, run.id, "export"))
      if (!response.ok) throw new Error(await extractResponseErrorMessage(response, "Export failed."))
      const url = URL.createObjectURL(new Blob([await response.text()], { type: "text/markdown" }))
      const link = document.createElement("a")
      link.href = url
      link.download = `lyta-drift-${comparison.id}-run-${run.number}.md`
      document.body.append(link)
      link.click()
      link.remove()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
      setStatusState(dom.status, "Drift report exported as Markdown.", "success")
      announce("Drift report exported.")
    } catch (error) {
      setStatusState(dom.status, getErrorMessage(error, "Export failed."), "error")
    }
  }

  function createBadge(status, text = DIFF_LABELS[status]) {
    const badge = document.createElement("span")
    badge.className = "drift-badge"
    badge.dataset.diff = status
    badge.textContent = text
    return badge
  }

  function shortVersion(sourceVersionId) {
    const hash = sourceVersionId.replace(/^source-version:/, "")
    return hash.length > 12 ? `${hash.slice(0, 12)}…` : hash
  }

  function formatImported(iso) {
    const date = new Date(iso)
    return Number.isNaN(date.getTime()) ? iso : `${iso.slice(0, 16).replace("T", " ")} UTC`
  }

  function labelFor(disposition) {
    return DISPOSITIONS.find(option => option.value === disposition)?.label || "Undecided"
  }
})()
