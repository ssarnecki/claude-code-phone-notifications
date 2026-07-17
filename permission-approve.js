#!/usr/bin/env node
// PermissionRequest hook: pushes an Approve/Deny notification to the phone via ntfy.sh
// and blocks until the user taps a button (or the timeout elapses, in which case
// Claude Code falls back to the normal interactive prompt). Uses ntfy's JSON publish
// API throughout (not headers) so title/tags can contain unicode/emoji safely.
const https = require('https');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const { log, projectName, publish, waitForGraceOrResolution } = require('./notify-lib.js');

const TOPIC = 'REPLACE_WITH_YOUR_NTFY_TOPIC'; // e.g. cc-<random hex>, generated once, keep it private
const REPLY_BASE = `${TOPIC}-reply`;
const TIMEOUT_MS = 9 * 60 * 1000; // keep below the hook's configured 600s timeout
const SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');
const GRACE_MS = 30000; // wait this long before pushing, in case it's answered at the computer first

// Exact-match only (never a wildcard/prefix) — "Approve All" should only ever
// skip the prompt for this identical call again, never something broader.
function buildRule(toolName, toolInput) {
    toolInput = toolInput || {};
    if (toolName === 'Bash' && toolInput.command) return `Bash(${toolInput.command})`;
    if (toolName === 'WebFetch' && toolInput.url) {
        try { return `WebFetch(domain:${new URL(toolInput.url).hostname})`; } catch (_) { /* fall through */ }
    }
    if (toolInput.file_path) {
        const p = toolInput.file_path.startsWith('/') ? `/${toolInput.file_path}` : toolInput.file_path;
        return `${toolName}(${p})`;
    }
    return toolName;
}

function persistRule(toolName, toolInput) {
    const rule = buildRule(toolName, toolInput);
    try {
        const settings = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf8'));
        settings.permissions = settings.permissions || {};
        settings.permissions.allow = settings.permissions.allow || [];
        if (!settings.permissions.allow.includes(rule)) {
            settings.permissions.allow.push(rule);
            fs.writeFileSync(SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n');
        }
    } catch (e) {
        process.stderr.write(`[permission-approve] failed to persist rule: ${e.message}\n`);
    }
    return rule;
}

function summarize(toolName, toolInput) {
    if (!toolInput) return toolName || 'tool call';
    if (toolInput.command) return `${toolName}: ${toolInput.command}`.slice(0, 250);
    if (toolInput.file_path) return `${toolName}: ${toolInput.file_path}`;
    if (toolInput.url) return `${toolName}: ${toolInput.url}`;
    return toolName || 'tool call';
}

function sendNotification(summary, cwd, replyTopic) {
    return publish({
        topic: TOPIC,
        title: `Approve? ${cwd || ''}`.trim(),
        message: summary,
        priority: 5,
        tags: ['lock'],
        actions: [
            { action: 'http', label: 'Approve', url: `https://ntfy.sh/${replyTopic}`, method: 'POST', body: 'allow', clear: true },
            { action: 'http', label: 'Approve All', url: `https://ntfy.sh/${replyTopic}`, method: 'POST', body: 'allow_all', clear: true },
            { action: 'http', label: 'Deny', url: `https://ntfy.sh/${replyTopic}`, method: 'POST', body: 'deny', clear: true },
        ],
    });
}

function sendConfirmation(decision, summary, rule) {
    let title, tags, message;
    if (decision === 'allow') { title = '✅ Approved'; tags = ['white_check_mark']; message = summary; }
    else if (decision === 'allow_all') { title = '✅ Approved + saved for next time'; tags = ['white_check_mark', 'floppy_disk']; message = rule || summary; }
    else if (decision === 'deny') { title = '❌ Denied'; tags = ['x']; message = summary; }
    else return Promise.resolve(); // no response within the timeout -> silently falls back to the terminal prompt, no push

    return publish({ topic: TOPIC, title, message: message || '', tags });
}

function waitForReply(replyTopic, timeoutMs) {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            req.destroy();
            resolve(value);
        };

        const req = https.get(`https://ntfy.sh/${replyTopic}/json`, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let idx;
                while ((idx = buf.indexOf('\n')) >= 0) {
                    const line = buf.slice(0, idx).trim();
                    buf = buf.slice(idx + 1);
                    if (!line) continue;
                    try {
                        const msg = JSON.parse(line);
                        if (msg.event === 'message' && msg.message) {
                            finish(msg.message.trim().toLowerCase());
                            return;
                        }
                    } catch (_) { /* ignore keepalive/open lines */ }
                }
            });
            res.on('end', () => finish(null));
            res.on('error', () => finish(null));
        });
        req.on('error', () => finish(null));

        const timer = setTimeout(() => finish(null), timeoutMs);
    });
}

let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { raw += chunk; });
process.stdin.on('end', async () => {
    let data;
    try {
        data = JSON.parse(raw);
    } catch (_) {
        process.exit(0);
    }

    // AskUserQuestion can carry several questions each with their own options —
    // an Approve/Deny decision doesn't map to that. ask-question-notify.js (wired
    // to PreToolUse) sends the actual phone notification for this tool instead.
    if (data.tool_name === 'AskUserQuestion') {
        log('permission:skipped_ask_user_question', {});
        process.exit(0);
    }

    const toolName = data.tool_name;
    const toolInput = data.tool_input;
    const cwd = data.cwd ? projectName(data.cwd) : '';
    const summary = summarize(toolName, toolInput);

    log('permission:hook_start', { toolName, summary, transcriptPath: data.transcript_path || null });

    process.stderr.write(`[permission-approve] watching transcript for ${GRACE_MS}ms in case it's answered at the computer first\n`);
    const resolvedAtComputer = await waitForGraceOrResolution(data.transcript_path, toolName, toolInput, GRACE_MS, 'permission');
    if (resolvedAtComputer) {
        process.stderr.write('[permission-approve] already resolved at the computer — skipping phone push\n');
        process.exit(0);
    }

    const nonce = crypto.randomBytes(4).toString('hex');
    const replyTopic = `${REPLY_BASE}-${nonce}`;

    log('permission:pushing', { toolName, summary });
    await sendNotification(summary, cwd, replyTopic);
    process.stderr.write(`[permission-approve] sent to phone, waiting on reply topic: ${replyTopic}\n`);
    const decision = await waitForReply(replyTopic, TIMEOUT_MS);
    log('permission:decision', { toolName, decision });

    let rule;
    if (decision === 'allow_all') rule = persistRule(toolName, toolInput);
    await sendConfirmation(decision, summary, rule);

    if (decision === 'allow' || decision === 'allow_all') {
        console.log(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
        }));
    } else if (decision === 'deny') {
        console.log(JSON.stringify({
            hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'deny' } },
        }));
    }
    // else: no output at all -> Claude Code falls back to the normal interactive prompt
    process.exit(0);
});
