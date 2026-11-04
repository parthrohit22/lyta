"use strict";
window.LytaDrift = (() => {
    const ROLES = ["specification", "architecture", "implementation"];
    const RULE_IDS = [
        "requirement-without-support",
        "component-without-implementation",
        "interface-contradiction",
        "stale-or-missing-source"
    ];
    const ROLE_LABELS = {
        specification: "Specification / PRD",
        architecture: "Architecture / design",
        implementation: "Implementation evidence"
    };
    const RULES = {
        "requirement-without-support": { code: "D1", title: "Requirement without support" },
        "component-without-implementation": { code: "D2", title: "Component without implementation" },
        "interface-contradiction": { code: "D3", title: "Interface or constraint contradiction" },
        "stale-or-missing-source": { code: "D4", title: "Stale or missing source" }
    };
    const CONFIDENCE_LABELS = {
        high: "High confidence",
        medium: "Medium confidence",
        low: "Low confidence"
    };
    const DIFF_LABELS = {
        new: "New",
        unchanged: "Unchanged",
        resolved: "Resolved"
    };
    const DISPOSITIONS = [
        { value: "confirmed", label: "Confirmed" },
        { value: "accepted-deviation", label: "Accepted deviation" },
        { value: "false-positive", label: "False positive" },
        { value: "needs-investigation", label: "Needs investigation" },
        { value: "undecided", label: "Undecided" }
    ];
    const DISPOSITION_VALUES = DISPOSITIONS.map((option) => option.value);
    function asRecord(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    function asText(value) {
        return typeof value === "string" ? value : "";
    }
    function asNumber(value) {
        return typeof value === "number" && Number.isFinite(value) ? value : 0;
    }
    function asTextList(value) {
        return Array.isArray(value) ? value.filter((item) => typeof item === "string" && Boolean(item.trim())) : [];
    }
    function asList(value) {
        return Array.isArray(value) ? value : [];
    }
    function pick(value, allowed, fallback) {
        return allowed.includes(value) ? value : fallback;
    }
    function normalizeFinding(value) {
        const record = asRecord(value);
        const counterpart = asRecord(record.counterpart);
        const key = asText(record.key);
        const rule = RULE_IDS.find((id) => id === record.rule);
        if (!key || !rule) {
            return null;
        }
        return {
            key,
            id: asText(record.id) || RULES[rule].code,
            rule,
            subject: asText(record.subject) || key,
            claim: asText(record.claim),
            claimRole: record.claimRole ? pick(record.claimRole, ROLES, "specification") : null,
            claimCitationIds: asTextList(record.claimCitationIds),
            counterpart: {
                // An unknown kind is shown as an absence, never as cited evidence.
                kind: pick(counterpart.kind, ["cited", "not-found-in-supplied-evidence", "source-check"], "not-found-in-supplied-evidence"),
                description: asText(counterpart.description),
                citationIds: asTextList(counterpart.citationIds),
                searchedSources: asTextList(counterpart.searchedSources)
            },
            detail: asText(record.detail),
            confidence: pick(record.confidence, ["high", "medium", "low"], "low"),
            confidenceReason: asText(record.confidenceReason),
            adjustments: asTextList(record.adjustments),
            diffStatus: pick(record.diffStatus, ["new", "unchanged"], "new")
        };
    }
    function normalizeRun(value) {
        const record = asRecord(value);
        const id = asText(record.id);
        if (!id) {
            return null;
        }
        const diff = asRecord(record.diff);
        return {
            id,
            number: asNumber(record.number),
            scope: asText(record.scope),
            rules: asTextList(record.rules).filter((rule) => RULE_IDS.includes(rule)),
            createdAt: asText(record.createdAt),
            summary: asText(record.summary),
            policyVersion: asText(record.policyVersion),
            modelVersion: asText(record.modelVersion),
            sources: asList(record.sources).map((item) => {
                const source = asRecord(item);
                return {
                    role: pick(source.role, ROLES, "specification"),
                    fileId: asText(source.fileId),
                    fileName: asText(source.fileName) || "Source",
                    sourceVersionId: asText(source.sourceVersionId),
                    importedAt: asText(source.importedAt),
                    superseded: Boolean(source.supersededBy)
                };
            }),
            evidence: asList(record.evidence).map((item) => {
                const evidence = asRecord(item);
                return {
                    ref: asText(evidence.ref),
                    chunkId: asText(evidence.chunkId),
                    fileId: asText(evidence.fileId),
                    fileName: asText(evidence.fileName) || "Source",
                    role: pick(evidence.role, ROLES, "specification"),
                    snippet: asText(evidence.snippet),
                    rank: asNumber(evidence.rank),
                    retrievalSize: asNumber(evidence.retrievalSize),
                    sourceDeleted: evidence.sourceDeleted === true
                };
            }),
            coverage: asList(record.coverage).map((item) => {
                const coverage = asRecord(item);
                return {
                    role: pick(coverage.role, ROLES, "specification"),
                    sourceCount: asNumber(coverage.sourceCount),
                    passageCount: asNumber(coverage.passageCount),
                    sourcesWithoutPassages: asTextList(coverage.sourcesWithoutPassages)
                };
            }),
            findings: asList(record.findings)
                .map(normalizeFinding)
                .filter((finding) => Boolean(finding)),
            resolved: asList(diff.resolved)
                .map((item) => {
                const resolved = asRecord(item);
                return {
                    key: asText(resolved.key),
                    rule: pick(resolved.rule, RULE_IDS, "stale-or-missing-source"),
                    subject: asText(resolved.subject),
                    claim: asText(resolved.claim),
                    lastSeenRunNumber: asNumber(resolved.lastSeenRunNumber)
                };
            })
                .filter((item) => item.key),
            previousRunNumber: asNumber(diff.previousRunNumber),
            adjustments: asTextList(record.adjustments)
        };
    }
    function normalizeDisposition(value) {
        const record = asRecord(value);
        return {
            disposition: pick(record.disposition, DISPOSITION_VALUES, "undecided"),
            note: asText(record.note),
            at: asText(record.at),
            history: asList(record.history).map((item) => {
                const entry = asRecord(item);
                return { disposition: pick(entry.disposition, DISPOSITION_VALUES, "undecided"), note: asText(entry.note), at: asText(entry.at) };
            })
        };
    }
    function normalizeComparison(value) {
        const record = asRecord(value);
        const id = asText(record.id);
        if (!id) {
            return null;
        }
        return {
            id,
            scope: asText(record.scope),
            runs: asList(record.runs).map((item) => {
                const run = asRecord(item);
                return {
                    id: asText(run.id),
                    number: asNumber(run.number),
                    createdAt: asText(run.createdAt),
                    findingCount: asNumber(run.findingCount),
                    newCount: asNumber(run.newCount),
                    resolvedCount: asNumber(run.resolvedCount)
                };
            }),
            dispositions: Object.fromEntries(Object.entries(asRecord(record.dispositions)).map(([key, item]) => [key, normalizeDisposition(item)]))
        };
    }
    function normalizeSummaries(value) {
        return asList(value)
            .map((item) => {
            const record = asRecord(item);
            return {
                id: asText(record.id),
                title: asText(record.title) || "Untitled drift check",
                runCount: asNumber(record.runCount),
                findingCount: asNumber(asRecord(record.latestRun).findingCount),
                updatedAt: asText(record.updatedAt)
            };
        })
            .filter((summary) => summary.id);
    }
    function getEvidence(run, chunkIds) {
        return chunkIds
            .map((chunkId) => run.evidence.find((item) => item.chunkId === chunkId))
            .filter((item) => Boolean(item));
    }
    /** The counterpart state shown when a finding is selected. Absence is always worded as absence from the supplied evidence. */
    function describeCounterpart(finding) {
        switch (finding.counterpart.kind) {
            case "cited":
                return {
                    state: "cited",
                    label: "Conflicting evidence",
                    description: "Both sides are cited from retrieved passages, shown below."
                };
            case "source-check":
                return {
                    state: "source-check",
                    label: "Source check",
                    description: "A fact about the supplied sources, not about the project."
                };
            default:
                return {
                    state: "not-found",
                    label: "Not found in the supplied evidence",
                    description: `No retrieved passage${finding.counterpart.searchedSources.length ? ` from ${finding.counterpart.searchedSources.join(", ")}` : ""} supports it. That does not show it is absent from the project.`
                };
        }
    }
    function dispositionOf(comparison, key) {
        return comparison.dispositions[key] || { disposition: "undecided", note: "", at: "", history: [] };
    }
    /** Turns per-file role choices into the request's role map, or explains what is missing. */
    function buildSelection(choices) {
        const sources = { specification: [], architecture: [], implementation: [] };
        for (const choice of choices) {
            const role = ROLES.find((candidate) => candidate === choice.role);
            if (role && choice.fileId)
                sources[role].push(choice.fileId);
        }
        const missing = ROLES.filter((role) => !sources[role].length);
        return {
            sources,
            error: missing.length ? `Choose at least one source for ${missing.map((role) => ROLE_LABELS[role]).join(", ")}.` : ""
        };
    }
    function buildRunAnnouncement(run) {
        const count = run.findings.length;
        const fresh = run.findings.filter((finding) => finding.diffStatus === "new").length;
        const unchanged = count - fresh;
        return `Drift run ${run.number} ready: ${count} finding${count === 1 ? "" : "s"}. ${fresh} new, ${unchanged} unchanged, ${run.resolved.length} resolved since the previous run.`;
    }
    function buildDispositionAnnouncement(finding, disposition) {
        const label = DISPOSITIONS.find((option) => option.value === disposition)?.label || "Undecided";
        return `${finding.id} ${finding.subject}: marked ${label.toLowerCase()}. Kept for later runs.`;
    }
    function driftPath(comparisonId) {
        return `/drift/${encodeURIComponent(comparisonId)}`;
    }
    function runsPath(comparisonId) {
        return `${driftPath(comparisonId)}/runs`;
    }
    function runPath(comparisonId, runId, suffix) {
        return `${runsPath(comparisonId)}/${encodeURIComponent(runId)}${suffix ? `/${suffix}` : ""}`;
    }
    function dispositionsPath(comparisonId) {
        return `${driftPath(comparisonId)}/dispositions`;
    }
    return {
        COMPARISON_TYPE: "spec-architecture-implementation",
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
    };
})();
