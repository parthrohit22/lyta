"use strict";
window.LytaReview = (() => {
    const READINESS_LABELS = {
        ready: "Ready",
        "needs evidence": "Needs evidence",
        blocked: "Blocked"
    };
    const CLASSIFICATION_LABELS = {
        "evidence-backed": "Evidence-backed",
        inference: "Inference",
        recommendation: "Recommendation",
        "insufficient evidence": "Insufficient evidence"
    };
    const DISPOSITIONS = [
        { value: "accepted", label: "Accept" },
        { value: "rejected", label: "Reject" },
        { value: "unresolved", label: "Unresolved" }
    ];
    const RECORD_KINDS = [
        { value: "finding", label: "Finding" },
        { value: "decision", label: "Decision" },
        { value: "risk", label: "Risk" },
        { value: "assumption", label: "Assumption" },
        { value: "follow-up", label: "Follow-up" }
    ];
    const CONTEXT_KIND_LABELS = {
        decision: "Decisions",
        risk: "Risks",
        assumption: "Assumptions",
        "follow-up": "Follow-ups",
        finding: "Findings",
        summary: "Summaries"
    };
    const CHALLENGE_OUTCOME_LABELS = {
        upheld: "Upheld",
        revised: "Revised",
        withdrawn: "Withdrawn",
        "insufficient evidence": "Insufficient evidence"
    };
    function asRecord(value) {
        return value && typeof value === "object" && !Array.isArray(value) ? value : {};
    }
    function asText(value) {
        return typeof value === "string" ? value : "";
    }
    function asTextList(value) {
        return Array.isArray(value) ? value.filter((item) => typeof item === "string" && Boolean(item.trim())) : [];
    }
    function pick(value, allowed, fallback) {
        return allowed.includes(value) ? value : fallback;
    }
    function normalizeReadiness(value) {
        return pick(value, ["ready", "needs evidence", "blocked"], "needs evidence");
    }
    function normalizeFinding(value) {
        const record = asRecord(value);
        const id = asText(record.id);
        const title = asText(record.title);
        if (!id || !title) {
            return null;
        }
        return {
            id,
            title,
            detail: asText(record.detail),
            // Unknown classifications are shown as the weakest claim, never as evidence.
            classification: pick(record.classification, ["evidence-backed", "inference", "recommendation", "insufficient evidence"], "inference"),
            areaType: asText(record.areaType) || "other",
            area: asText(record.area),
            citationIds: asTextList(record.citationIds),
            adjustments: asTextList(record.adjustments),
            disposition: pick(record.disposition, ["accepted", "rejected", "unresolved"], "unresolved"),
            dispositionNote: asText(record.dispositionNote),
            recordKind: record.recordKind
                ? pick(record.recordKind, ["finding", "decision", "risk", "assumption", "follow-up"], "finding")
                : null,
            withdrawn: record.withdrawn === true,
            challenges: (Array.isArray(record.challenges) ? record.challenges : []).map(normalizeChallenge)
        };
    }
    function normalizeChallenge(value) {
        const record = asRecord(value);
        return {
            id: asText(record.id),
            createdAt: asText(record.createdAt),
            reason: asText(record.reason),
            outcome: pick(record.outcome, ["upheld", "revised", "withdrawn", "insufficient evidence"], "insufficient evidence"),
            conclusionChanged: record.conclusionChanged === true,
            rationale: asText(record.rationale),
            counterEvidenceIds: asTextList(record.counterEvidenceIds),
            beforeTitle: asText(asRecord(record.before).title),
            afterTitle: asText(asRecord(record.after).title),
            adjustments: asTextList(record.adjustments)
        };
    }
    /** Context records from GET /context?includeContent=true, newest first, with source ids resolved to names. */
    function normalizeContextRecords(value) {
        const data = asRecord(value);
        const sourceNames = new Map((Array.isArray(data.sources) ? data.sources : []).map((source) => [asText(asRecord(source).id), asText(asRecord(source).name)]));
        return (Array.isArray(data.records) ? data.records : [])
            .map((item) => {
            const record = asRecord(item);
            const origin = asRecord(record.origin);
            return {
                id: asText(record.id),
                kind: asText(record.kind) || "finding",
                title: asText(record.title),
                content: asText(record.content),
                sourceNames: asTextList(asRecord(record.provenance).sourceFileIds)
                    .map((id) => sourceNames.get(id) || "")
                    .filter(Boolean),
                reviewId: asText(origin.reviewId),
                findingId: asText(origin.findingId),
                updatedAt: asText(record.updatedAt)
            };
        })
            .filter((record) => record.id && record.title)
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    }
    function normalizeReview(value) {
        const record = asRecord(value);
        const id = asText(record.id);
        if (!id) {
            return null;
        }
        const input = asRecord(record.input);
        return {
            id,
            readiness: normalizeReadiness(record.readiness),
            rationale: asText(record.rationale),
            proposedChange: asText(input.proposedChange),
            intendedOutcome: asText(input.intendedOutcome),
            constraints: asText(input.constraints),
            sourceFileIds: asTextList(input.sourceFileIds),
            policyVersion: asText(record.policyVersion),
            sources: (Array.isArray(record.sources) ? record.sources : []).map((source) => {
                const item = asRecord(source);
                return { fileId: asText(item.fileId), fileName: asText(item.fileName), sourceVersionId: asText(item.sourceVersionId) };
            }),
            findings: (Array.isArray(record.findings) ? record.findings : [])
                .map(normalizeFinding)
                .filter((finding) => Boolean(finding)),
            conflicts: (Array.isArray(record.conflicts) ? record.conflicts : []).map((conflict) => {
                const item = asRecord(conflict);
                return { description: asText(item.description), citationIds: asTextList(item.citationIds) };
            }),
            requiredTests: asTextList(record.requiredTests),
            observability: asTextList(record.observability),
            rollback: asTextList(record.rollback),
            missingEvidence: asTextList(record.missingEvidence),
            assumptions: asTextList(record.assumptions),
            openQuestions: asTextList(record.openQuestions),
            nextActions: asTextList(record.nextActions),
            adjustments: asTextList(record.adjustments),
            evidence: (Array.isArray(record.evidence) ? record.evidence : []).map((evidence) => {
                const item = asRecord(evidence);
                return {
                    ref: asText(item.ref),
                    chunkId: asText(item.chunkId),
                    fileId: asText(item.fileId),
                    fileName: asText(item.fileName) || "Source",
                    snippet: asText(item.snippet),
                    sourceDeleted: item.sourceDeleted === true,
                    retrievedFor: asText(item.retrievedFor) || "review",
                    rank: typeof item.rank === "number" ? item.rank : 0,
                    retrievalSize: typeof item.retrievalSize === "number" ? item.retrievalSize : 0
                };
            }),
            sourceNames: (Array.isArray(record.sources) ? record.sources : []).map((source) => asText(asRecord(source).fileName)).filter(Boolean),
            createdAt: asText(record.createdAt)
        };
    }
    function normalizeReviewSummaries(value) {
        return (Array.isArray(value) ? value : [])
            .map((item) => {
            const record = asRecord(item);
            return {
                id: asText(record.id),
                title: asText(record.title) || "Untitled review",
                readiness: normalizeReadiness(record.readiness),
                findingCount: typeof record.findingCount === "number" ? record.findingCount : 0,
                createdAt: asText(record.createdAt)
            };
        })
            .filter((summary) => summary.id);
    }
    function getFindingEvidence(review, finding) {
        return finding.citationIds
            .map((chunkId) => review.evidence.find((item) => item.chunkId === chunkId))
            .filter((item) => Boolean(item));
    }
    /** The evidence state shown when a claim is selected; the copy never claims more than the classification allows. */
    function describeEvidenceState(finding, citedCount) {
        if (finding.withdrawn) {
            return { state: "withdrawn", label: "Withdrawn", description: "A challenge found counter-evidence, so this claim no longer stands." };
        }
        switch (finding.classification) {
            case "evidence-backed":
                return citedCount
                    ? {
                        state: "evidence-backed",
                        label: "Evidence-backed",
                        description: `Supported by ${citedCount} retrieved passage${citedCount === 1 ? "" : "s"} shown below.`
                    }
                    : {
                        state: "unsupported",
                        label: "Unsupported",
                        description: "Marked evidence-backed, but none of its cited passages are available."
                    };
            case "recommendation":
                return {
                    state: "recommendation",
                    label: "Recommendation",
                    description: "A suggested action, not a factual claim about the sources."
                };
            case "insufficient evidence":
                return {
                    state: "insufficient-evidence",
                    label: "Insufficient evidence",
                    description: "The selected sources do not answer this. Add material or challenge it to search again."
                };
            default:
                return { state: "inference", label: "Inference", description: "LYTA's reasoning. No retrieved passage states this directly." };
        }
    }
    /** Where a passage came from: which retrieval, its rank, and the context policy. */
    function describeRetrieval(review, evidence) {
        const by = evidence.retrievedFor === "review" ? "Retrieved for this review" : `Retrieved by challenge ${evidence.retrievedFor}`;
        const rank = evidence.rank ? `, rank ${evidence.rank}${evidence.retrievalSize ? ` of ${evidence.retrievalSize}` : ""}` : "";
        const policy = review.policyVersion ? ` · policy ${review.policyVersion}${evidence.retrievedFor === "review" ? "" : ".challenge"}` : "";
        return `${by}${rank}${policy}`;
    }
    function buildReviewAnnouncement(review) {
        const backed = review.findings.filter((finding) => finding.classification === "evidence-backed" && !finding.withdrawn).length;
        const count = review.findings.length;
        return `Review ready: ${READINESS_LABELS[review.readiness]}. ${count} finding${count === 1 ? "" : "s"}, ${backed} evidence-backed.${review.missingEvidence.length ? ` ${review.missingEvidence.length} gaps in evidence.` : ""}`;
    }
    function buildChallengeAnnouncement(findingId, outcome, conclusionChanged) {
        const label = CHALLENGE_OUTCOME_LABELS[outcome] || "Recorded";
        return `${findingId} challenge: ${label}. The conclusion ${conclusionChanged ? "changed" : "did not change"}.`;
    }
    function countRecordsByKind(records) {
        return records.reduce((counts, record) => {
            counts[record.kind] = (counts[record.kind] || 0) + 1;
            return counts;
        }, {});
    }
    function reviewPath(reviewId, suffix) {
        return `/reviews/${encodeURIComponent(reviewId)}${suffix ? `/${suffix}` : ""}`;
    }
    function findingPath(reviewId, findingId) {
        return `${reviewPath(reviewId)}/findings/${encodeURIComponent(findingId)}`;
    }
    function challengePath(reviewId, findingId) {
        return `${findingPath(reviewId, findingId)}/challenge`;
    }
    return {
        READINESS_LABELS,
        CLASSIFICATION_LABELS,
        DISPOSITIONS,
        RECORD_KINDS,
        CONTEXT_KIND_LABELS,
        CHALLENGE_OUTCOME_LABELS,
        normalizeReview,
        normalizeContextRecords,
        normalizeReviewSummaries,
        getFindingEvidence,
        describeEvidenceState,
        describeRetrieval,
        buildReviewAnnouncement,
        buildChallengeAnnouncement,
        countRecordsByKind,
        reviewPath,
        findingPath,
        challengePath
    };
})();
