#!/usr/bin/env node
// PreToolUse(AskUserQuestion) hook: a plain "you have a question" push, no action
// buttons — AskUserQuestion can carry multiple questions each with their own set
// of options (sometimes multi-select), so there's no sane way to represent that
// as a couple of notification buttons. Just tells you to go look at the screen.
// Skips the push entirely if the transcript shows you already answered on the
// computer within the grace period (same mechanism as permission-approve.js).
const { log, projectName, publish, waitForGraceOrResolution } = require('./notify-lib.js');

const TOPIC = 'REPLACE_WITH_YOUR_NTFY_TOPIC'; // e.g. cc-<random hex>, generated once, keep it private
const GRACE_MS = 30000;

function summarizeQuestions(toolInput) {
    const questions = (toolInput && toolInput.questions) || [];
    if (!questions.length) return 'Claude has a question';
    const first = questions[0].question || questions[0].header || 'question';
    return questions.length > 1 ? `${first} (+${questions.length - 1} more)` : first;
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

    const toolName = data.tool_name;
    const toolInput = data.tool_input;
    const cwd = data.cwd ? projectName(data.cwd) : '';
    const summary = summarizeQuestions(toolInput);

    log('question:hook_start', { toolName, summary, transcriptPath: data.transcript_path || null });

    const resolvedAtComputer = await waitForGraceOrResolution(data.transcript_path, toolName, toolInput, GRACE_MS, 'question');
    if (resolvedAtComputer) {
        log('question:skipped', { toolName });
        process.exit(0);
    }

    log('question:pushing', { toolName, summary });
    await publish({
        topic: TOPIC,
        title: `Question in ${cwd || ''}`.trim(),
        message: summary,
        priority: 4,
        tags: ['thinking_face'],
    });
    process.exit(0);
});
