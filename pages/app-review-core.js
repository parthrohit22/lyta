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
            dispositionNote: asText(record.dispositionNote)
        };
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
            adjustments: asTextList(record.adjustments),
            evidence: (Array.isArray(record.evidence) ? record.evidence : []).map((evidence) => {
                const item = asRecord(evidence);
                return {
                    ref: asText(item.ref),
                    chunkId: asText(item.chunkId),
                    fileId: asText(item.fileId),
                    fileName: asText(item.fileName) || "Source",
                    snippet: asText(item.snippet),
                    sourceDeleted: item.sourceDeleted === true
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
    function reviewPath(reviewId, suffix) {
        return `/reviews/${encodeURIComponent(reviewId)}${suffix ? `/${suffix}` : ""}`;
    }
    function findingPath(reviewId, findingId) {
        return `${reviewPath(reviewId)}/findings/${encodeURIComponent(findingId)}`;
    }
    return {
        READINESS_LABELS,
        CLASSIFICATION_LABELS,
        DISPOSITIONS,
        normalizeReview,
        normalizeReviewSummaries,
        getFindingEvidence,
        reviewPath,
        findingPath
    };
})();
