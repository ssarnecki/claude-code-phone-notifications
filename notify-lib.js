// Shared helpers for Claude Code -> phone notification hooks (ntfy.sh based).
// Used by permission-approve.js and ask-question-notify.js — keep logic that's
// shared between "should we buzz the phone at all" checks in here so fixes
// (e.g. the transcript-flush race) don't have to be made in two places.
const https = require('https');
const fs = require('fs');
const path = require('path');

const LOG_PATH = '/tmp/permission-approve.log';

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(event, fields) {
    try {
        fs.appendFileSync(LOG_PATH, JSON.stringify({ t: new Date().toISOString(), event, ...fields }) + '\n');
    } catch (_) { /* ignore */ }
}

// Reads the whole transcript file. Deliberately NOT a fixed-size tail (and not
// an offset anchored at hook-start either — tried that, it broke the same way):
// under heavy parallel tool activity (many subagents/commands appending large
// results at once), the entry we actually care about can already be well behind
// any fixed-size window, or behind any offset computed from the *current* file
// size, by the time our hook gets a chance to even run its first check. A full
// read is simple, always correct regardless of concurrent write volume, and
// cheap enough at any realistic transcript size for how infrequently this runs.
function readAll(filePath) {
    try {
        return fs.readFileSync(filePath, 'utf8');
    } catch (_) {
        return '';
    }
}

// Treats a missing key the same as an explicit false/null/undefined — Claude
// Code fills in tool-schema defaults (e.g. AskUserQuestion's multiSelect:false)
// before handing tool_input to hooks, but the transcript's logged tool_use entry
// keeps whatever the model actually emitted, which can omit that same key.
function normalizeFalsy(v) {
    return v === undefined || v === null || v === false ? ' falsy' : v;
}

function looseDeepEqual(a, b) {
    a = normalizeFalsy(a);
    b = normalizeFalsy(b);
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object') return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        return a.every((v, i) => looseDeepEqual(v, b[i]));
    }
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) {
        if (!looseDeepEqual(a[k], b[k])) return false;
    }
    return true;
}

function matchesToolInput(toolInput, entryInput) {
    if (!entryInput) return false;
    if (toolInput.command !== undefined) return entryInput.command === toolInput.command;
    if (toolInput.file_path !== undefined) return entryInput.file_path === toolInput.file_path;
    if (toolInput.url !== undefined) return entryInput.url === toolInput.url;
    return looseDeepEqual(entryInput, toolInput);
}

// Subagents (spawned via the Task tool) log their own tool_use/tool_result
// entries to a SEPARATE file — <session-dir>/<session-id>/subagents/*.jsonl —
// not the main session transcript the hook is handed. A tool call made from
// inside a subagent is therefore invisible to a lookup that only checks
// transcriptPath, no matter how big the read window is. Re-derived on every
// call (not cached) since new subagent files can appear mid-session.
function subagentTranscriptPaths(transcriptPath) {
    try {
        const dir = path.dirname(transcriptPath);
        const base = path.basename(transcriptPath, '.jsonl');
        const subDir = path.join(dir, base, 'subagents');
        return fs.readdirSync(subDir)
            .filter((f) => f.endsWith('.jsonl'))
            .map((f) => path.join(subDir, f));
    } catch (_) {
        return [];
    }
}

function allTranscriptPaths(transcriptPath) {
    return [transcriptPath, ...subagentTranscriptPaths(transcriptPath)];
}

// Find the tool_use id Claude Code already logged for this pending call, by
// scanning the main transcript plus any subagent transcripts (newest-first
// within each) for the most recent matching entry.
function findToolUseId(transcriptPath, toolName, toolInput) {
    for (const p of allTranscriptPaths(transcriptPath)) {
        const lines = readAll(p).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i]) continue;
            let entry;
            try { entry = JSON.parse(lines[i]); } catch (_) { continue; }
            if (entry.type !== 'assistant') continue;
            const content = entry.message && entry.message.content;
            if (!Array.isArray(content)) continue;
            for (const item of content) {
                if (item.type === 'tool_use' && item.name === toolName && matchesToolInput(toolInput, item.input)) {
                    return item.id;
                }
            }
        }
    }
    return null;
}

// True once a tool_result for this id shows up in the main transcript or any
// subagent transcript — meaning the call already ran, i.e. it was resolved at
// the computer before our grace period elapsed.
function alreadyResolved(transcriptPath, toolUseId) {
    for (const p of allTranscriptPaths(transcriptPath)) {
        const lines = readAll(p).split('\n');
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!lines[i]) continue;
            let entry;
            try { entry = JSON.parse(lines[i]); } catch (_) { continue; }
            if (entry.type !== 'user') continue;
            const content = entry.message && entry.message.content;
            if (!Array.isArray(content)) continue;
            for (const item of content) {
                if (item.type === 'tool_result' && item.tool_use_id === toolUseId) return true;
            }
        }
    }
    return false;
}

// Poll the transcript during the grace window instead of blindly sleeping —
// callers should skip their notification entirely when this resolves true.
async function waitForGraceOrResolution(transcriptPath, toolName, toolInput, graceMs, logPrefix) {
    const startedAt = Date.now();
    if (!transcriptPath) {
        log(`${logPrefix}:no_transcript_path`, { toolName });
        await sleep(graceMs);
        return false;
    }
    const pollIntervalMs = 700;
    const deadline = startedAt + graceMs;
    let toolUseId = null;
    let toolUseIdFoundAtMs = null;
    while (Date.now() < deadline) {
        // The transcript write for this exact call can lag slightly behind the
        // hook starting, so keep retrying the lookup, not just the resolution check.
        if (!toolUseId) {
            toolUseId = findToolUseId(transcriptPath, toolName, toolInput);
            if (toolUseId) toolUseIdFoundAtMs = Date.now() - startedAt;
        }
        if (toolUseId && alreadyResolved(transcriptPath, toolUseId)) {
            log(`${logPrefix}:resolved_at_computer`, { toolName, toolUseId, foundAtMs: toolUseIdFoundAtMs, resolvedAtMs: Date.now() - startedAt });
            return true;
        }
        await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())));
    }
    if (!toolUseId) toolUseId = findToolUseId(transcriptPath, toolName, toolInput);
    const resolved = toolUseId ? alreadyResolved(transcriptPath, toolUseId) : false;
    log(`${logPrefix}:grace_expired`, { toolName, toolUseId, foundAtMs: toolUseIdFoundAtMs, resolved, elapsedMs: Date.now() - startedAt });
    return resolved;
}

function projectName(cwd) {
    let dir = cwd;
    while (true) {
        if (fs.existsSync(path.join(dir, '.git'))) return path.basename(dir);
        const parent = path.dirname(dir);
        if (parent === dir) return path.basename(cwd);
        dir = parent;
    }
}

function publish(payload) {
    return new Promise((resolve) => {
        const body = JSON.stringify(payload);
        const req = https.request('https://ntfy.sh/', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
            },
        }, (res) => {
            res.resume();
            res.on('end', resolve);
        });
        req.on('error', resolve);
        req.write(body);
        req.end();
    });
}

module.exports = { sleep, log, projectName, publish, waitForGraceOrResolution, findToolUseId, alreadyResolved };
