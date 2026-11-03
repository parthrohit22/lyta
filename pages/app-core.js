"use strict";
window.LytaCore = (() => {
    const MAX_ATTACHMENTS = 4;
    const ACTIVE_SESSION_KEY = "lyta_active_session";
    const THEME_MODE_KEY = "lyta_theme_mode";
    const DEFAULT_PROFILE = {
        name: "Guest User",
        workspace: "Private Workspace",
        email: ""
    };
    const DEFAULT_PREFERENCES = {
        ui: {
            sidebarHidden: false,
            boardOpen: true,
            chatMode: "instant"
        }
    };
    function normalizeChatModeValue(value) {
        return value === "deep" || value === "creative" ? value : "instant";
    }
    function getChatModeLabel(mode) {
        switch (normalizeChatModeValue(mode)) {
            case "deep":
                return "Deep";
            case "creative":
                return "Creative";
            default:
                return "Instant";
        }
    }
    function normalizeMessageRecord(message) {
        return {
            id: typeof message?.id === "string" ? message.id : crypto.randomUUID(),
            role: message?.role === "assistant" ? "assistant" : "user",
            content: typeof message?.content === "string" ? message.content : "",
            mode: normalizeChatModeValue(message?.mode),
            createdAt: typeof message?.createdAt === "string" ? message.createdAt : new Date().toISOString(),
            attachments: normalizeAttachments(message?.attachments),
            citations: normalizeCitations(message?.citations),
            followups: normalizeFollowups(message?.followups)
        };
    }
    function normalizeAttachments(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.map((attachment) => ({
            id: typeof attachment?.id === "string" ? attachment.id : crypto.randomUUID(),
            libraryFileId: typeof attachment?.libraryFileId === "string" ? attachment.libraryFileId : "",
            kind: attachment?.kind === "image" ? "image" : "document",
            name: typeof attachment?.name === "string" && attachment.name.trim() ? attachment.name.trim() : "Attachment",
            mimeType: typeof attachment?.mimeType === "string" && attachment.mimeType.trim() ? attachment.mimeType.trim() : "application/octet-stream",
            size: Number.isFinite(attachment?.size) ? attachment.size : 0,
            summary: typeof attachment?.summary === "string" ? attachment.summary : "",
            dataUrl: typeof attachment?.dataUrl === "string" ? attachment.dataUrl : "",
            extractedText: typeof attachment?.extractedText === "string" ? attachment.extractedText : ""
        }));
    }
    function normalizeCitations(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value
            .filter(Boolean)
            .map((citation, index) => ({
            id: typeof citation?.id === "string" ? citation.id : `source-${index + 1}`,
            label: typeof citation?.label === "string" && citation.label.trim() ? citation.label.trim() : `Source ${index + 1}`,
            fileId: typeof citation?.fileId === "string" ? citation.fileId : "",
            fileName: typeof citation?.fileName === "string" && citation.fileName.trim() ? citation.fileName.trim() : "Attachment",
            snippet: typeof citation?.snippet === "string" ? citation.snippet.trim() : ""
        }))
            .filter((citation) => citation.snippet);
    }
    function normalizeFollowups(value) {
        return Array.isArray(value)
            ? value
                .filter((item) => typeof item === "string")
                .map((item) => item.trim())
                .filter(Boolean)
                .slice(0, 3)
            : [];
    }
    function normalizeSessions(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        return value.map(normalizeSessionRecord).filter((session) => Boolean(session));
    }
    function normalizeSessionRecord(value) {
        if (typeof value?.id !== "string" || !value.id) {
            return null;
        }
        const timestamp = new Date().toISOString();
        return {
            id: value.id,
            title: typeof value?.title === "string" && value.title.trim() ? value.title.trim() : "New Chat",
            createdAt: typeof value?.createdAt === "string" ? value.createdAt : timestamp,
            updatedAt: typeof value?.updatedAt === "string" ? value.updatedAt : timestamp
        };
    }
    function normalizeProfile(profile, user) {
        return {
            name: typeof profile?.name === "string" && profile.name.trim() ? profile.name.trim() : DEFAULT_PROFILE.name,
            workspace: typeof profile?.workspace === "string" && profile.workspace.trim() ? profile.workspace.trim() : DEFAULT_PROFILE.workspace,
            email: typeof profile?.email === "string" && profile.email.trim()
                ? profile.email.trim()
                : typeof user?.email === "string"
                    ? user.email
                    : ""
        };
    }
    function normalizePreferences(preferences) {
        return {
            ui: {
                sidebarHidden: Boolean(preferences?.ui && preferences.ui?.sidebarHidden),
                boardOpen: preferences?.ui?.boardOpen !== false,
                chatMode: normalizeChatModeValue(preferences?.ui?.chatMode)
            }
        };
    }
    function normalizeLibraryFiles(value) {
        if (!Array.isArray(value)) {
            return [];
        }
        const timestamp = new Date().toISOString();
        return value.map((file) => ({
            libraryFileId: typeof file?.libraryFileId === "string" ? file.libraryFileId : crypto.randomUUID(),
            kind: file?.kind === "image" ? "image" : "document",
            name: typeof file?.name === "string" && file.name.trim() ? file.name.trim() : "Attachment",
            mimeType: typeof file?.mimeType === "string" && file.mimeType.trim() ? file.mimeType.trim() : "application/octet-stream",
            size: Number.isFinite(file?.size) ? file.size : 0,
            summary: typeof file?.summary === "string" ? file.summary : "",
            dataUrl: typeof file?.dataUrl === "string" ? file.dataUrl : "",
            extractedText: typeof file?.extractedText === "string" ? file.extractedText : "",
            createdAt: typeof file?.createdAt === "string" ? file.createdAt : timestamp,
            updatedAt: typeof file?.updatedAt === "string" ? file.updatedAt : timestamp
        }));
    }
    function normalizeThemeMode(value) {
        return value === "light" || value === "dark" ? value : "system";
    }
    function resolveThemeMode(mode) {
        if (mode === "light" || mode === "dark") {
            return mode;
        }
        return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
    }
    function toSingleLine(text, limit) {
        return (text || "").replace(/\s+/g, " ").trim().slice(0, limit);
    }
    function formatMimeLabel(mimeType) {
        if (!mimeType) {
            return "File";
        }
        const label = mimeType.split("/").pop() || mimeType;
        return label.replace(/[-+.]/g, " ").toUpperCase();
    }
    function formatBytes(size) {
        if (!size) {
            return "0 B";
        }
        const units = ["B", "KB", "MB", "GB"];
        let value = size;
        let index = 0;
        while (value >= 1024 && index < units.length - 1) {
            value /= 1024;
            index += 1;
        }
        return `${value >= 10 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
    }
    function formatRelativeTime(iso) {
        if (!iso) {
            return "Recently";
        }
        const delta = Date.now() - new Date(iso).getTime();
        if (!Number.isFinite(delta)) {
            return "Recently";
        }
        const minute = 60_000;
        const hour = minute * 60;
        const day = hour * 24;
        if (delta < minute)
            return "Just now";
        if (delta < hour)
            return `${Math.round(delta / minute)}m ago`;
        if (delta < day)
            return `${Math.round(delta / hour)}h ago`;
        return `${Math.round(delta / day)}d ago`;
    }
    function renderMarkdown(markdown, citations = [], fallback = "") {
        // Model and source-derived text is only ever inserted as Text nodes. This
        // does not rely on a separately loaded sanitizer, so a script load failure
        // leaves HTML-looking output inert.
        const source = markdown || fallback;
        const fragment = document.createDocumentFragment();
        const citationByLabel = new Map(citations.map((citation, index) => [citation.label, { citation, index }]));
        const labels = [...citationByLabel.keys()].filter(Boolean).sort((left, right) => right.length - left.length);
        if (!labels.length) {
            appendInertText(fragment, source);
            return fragment;
        }
        const markerPattern = new RegExp(`(${labels.map((label) => `\\[${escapeRegExp(label)}\\]`).join("|")})`, "g");
        let cursor = 0;
        for (const match of source.matchAll(markerPattern)) {
            const start = match.index || 0;
            appendInertText(fragment, source.slice(cursor, start));
            const label = match[0].slice(1, -1);
            const entry = citationByLabel.get(label);
            if (entry) {
                const marker = document.createElement("button");
                marker.type = "button";
                marker.className = "citation-marker";
                marker.dataset.citationIndex = String(entry.index);
                marker.setAttribute("aria-label", `Jump to source ${entry.index + 1}: ${entry.citation.fileName}`);
                marker.textContent = String(entry.index + 1);
                fragment.appendChild(marker);
            }
            else {
                appendInertText(fragment, match[0]);
            }
            cursor = start + match[0].length;
        }
        appendInertText(fragment, source.slice(cursor));
        return fragment;
    }
    function getFileTypeGlyph(mimeType, kind) {
        if (kind === "image") {
            return "IMG";
        }
        const sub = (mimeType || "").split("/").pop() || "";
        if (sub.includes("pdf"))
            return "PDF";
        if (sub.includes("wordprocessingml") || sub.includes("msword"))
            return "DOC";
        if (sub.includes("csv"))
            return "CSV";
        if (sub.includes("json"))
            return "JSON";
        if (sub.includes("markdown"))
            return "MD";
        if (sub.includes("html"))
            return "HTML";
        if (sub.includes("xml"))
            return "XML";
        if (sub.includes("plain"))
            return "TXT";
        return "FILE";
    }
    function setStatusState(element, message, stateName = "neutral", fallback = "") {
        element.textContent = message || fallback;
        if (stateName === "neutral") {
            delete element.dataset.state;
            return;
        }
        element.dataset.state = stateName;
    }
    function getInitials(name) {
        return ((name || "LY")
            .split(/\s+/)
            .filter(Boolean)
            .slice(0, 2)
            .map((part) => part[0]?.toUpperCase() || "")
            .join("") || "LY");
    }
    function hasDraggedFiles(event) {
        return Array.from(event.dataTransfer?.types || []).includes("Files");
    }
    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
    function appendInertText(target, text) {
        const lines = text.replace(/\r\n?/g, "\n").split("\n");
        lines.forEach((line, index) => {
            if (index) {
                target.appendChild(document.createElement("br"));
            }
            if (line) {
                target.appendChild(document.createTextNode(line));
            }
        });
    }
    function getErrorMessage(error, fallback = "Something went wrong.") {
        return error instanceof Error && error.message ? error.message : fallback;
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
        };
    }
    function clonePreferences(preferences) {
        return {
            ui: { ...preferences.ui }
        };
    }
    function slugify(value) {
        return (value || "")
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 48);
    }
    function looksLikeHtmlError(text) {
        return /^\s*</.test(text) || /Cloudflare|cf-error|Error 1101|Worker threw exception|Please enable cookies/i.test(text);
    }
    async function extractResponseErrorMessage(response, fallback) {
        let text = "";
        try {
            text = await response.text();
        }
        catch {
            return fallback;
        }
        const contentType = response.headers.get("Content-Type") || "";
        if (contentType.includes("application/json")) {
            try {
                const parsed = JSON.parse(text);
                const message = parsed?.error || parsed?.message;
                if (typeof message === "string" && message.trim()) {
                    return toSingleLine(message, 240);
                }
            }
            catch { }
        }
        const trimmed = text.trim();
        if (!trimmed || looksLikeHtmlError(trimmed)) {
            return fallback;
        }
        return toSingleLine(trimmed, 240) || fallback;
    }
    /**
     * Screen-reader-only announcement through the page's #liveAnnouncer /
     * #liveAlert regions. Clearing first makes repeated identical messages
     * ("Response complete.") announce again.
     */
    function announce(message, politeness = "polite") {
        const region = document.getElementById(politeness === "assertive" ? "liveAlert" : "liveAnnouncer");
        if (!region) {
            return;
        }
        region.textContent = "";
        window.setTimeout(() => {
            region.textContent = message;
        }, 50);
    }
    async function apiJson(path, options = {}) {
        const headers = new Headers(options.headers || undefined);
        if (options.body && !headers.has("Content-Type")) {
            headers.set("Content-Type", "application/json");
        }
        const response = await fetch(path, {
            ...options,
            headers
        });
        if (!response.ok) {
            throw new Error(await extractResponseErrorMessage(response, "Request failed."));
        }
        return response.json();
    }
    return {
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
    };
})();
