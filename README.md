# Claude Code Phone Notifications

Get iPhone/Android push notifications for [Claude Code](https://claude.com/claude-code) — approve or deny permission
requests from your phone with **Approve / Approve All / Deny** buttons, get notified
when Claude has a question for you, and get pinged when a task finishes. All of it
works even when you're away from your computer, not just when you're staring at
the terminal.

## Why this exists

Claude Code runs long, semi-autonomous coding sessions that regularly stop to ask
for permission (running a command, editing a file) or ask a clarifying question.
By default those prompts only show up in your terminal or IDE — if you step away,
Claude just sits there waiting, sometimes for the full length of a coffee break.
This project was built to solve that: real push notifications on your phone, with
actual Approve/Deny buttons so you can unblock Claude without opening a laptop,
plus enough safeguards (a grace period, exact-match-only auto-approval, silent
fallback to the terminal) that it stays useful instead of becoming spam.

It's built on [ntfy.sh](https://ntfy.sh) (free, no account needed, open source) —
Claude Code's hooks call out to it over HTTP, and your phone runs the ntfy app
subscribed to a private topic you generate yourself.

## What you get

- **Permission requests**: a phone push with Approve / Approve All / Deny buttons.
  - **Approve** — one-time approval, same as clicking it in the terminal.
  - **Approve All** — approves now *and* saves an exact-match rule to your
    `settings.json` allowlist, so the identical command/file/tool call skips the
    prompt next time. It only ever matches that literal call again — never a
    broader pattern — so it can't quietly widen what gets auto-approved.
  - **Deny** — denies it.
  - A confirmation push (✅/❌) follows once you tap, so you know it registered.
- **Questions** (`AskUserQuestion`): a plain push, no buttons — a question can
  carry several multi-choice sub-questions, which doesn't map to a couple of
  notification buttons, so this just tells you to go look at the screen.
- **Task completed**: a plain push, no buttons, fires immediately.
- Both permission and question notifications share a 30-second grace period:
  they watch your session transcript for signs you already answered at the
  computer, and skip the phone push entirely if so. Task-completed pushes have
  no grace period — there's no action to take, so no reason to delay them.
- Notification titles show your project's **git repo root name**, not whatever
  subdirectory a command happened to `cd` into.

## Prerequisites

- Node.js (any recent version) — used to run the hook scripts.
- The [ntfy](https://ntfy.sh/) app on your phone (iOS/Android, free).
- macOS only, optional: [terminal-notifier](https://github.com/julienXX/terminal-notifier)
  (`brew install terminal-notifier`) if you also want a desktop sound/notification
  alongside the phone push. Skip this if you don't want it or aren't on macOS.

## Setup

### 1. Generate your own private topic

Topic names on the free ntfy.sh service are public — anyone who guesses/knows the
name can read it or publish to it. Generate a long random one and keep it private,
same as a password:

```bash
python3 -c "import secrets; print('cc-' + secrets.token_hex(8))"
```

Save the output somewhere — you'll paste it into a few places below.

### 2. Subscribe on your phone

Install the ntfy app, tap **+**, and subscribe to the topic you just generated.

### 3. Install the scripts

Copy all three `.js` files from this folder into `~/.claude/`:
`notify-lib.js` (shared helpers — the other two require it), `permission-approve.js`,
and `ask-question-notify.js`.

In both `permission-approve.js` and `ask-question-notify.js`, replace
`REPLACE_WITH_YOUR_NTFY_TOPIC` (near the top of the file) with your actual topic
from step 1.

### 4. Wire up the hooks

Open `~/.claude/settings.json` (create it if it doesn't exist — it's just
`{}` at minimum). Merge the contents of `settings-hooks-snippet.json` (in this
folder) into its `hooks` object, replacing `REPLACE_WITH_YOUR_NTFY_TOPIC` in the
`Stop` hook's `curl` command with the same topic from step 1.

If you already have hooks configured (e.g. existing `PermissionRequest`, `PreToolUse`,
or `Stop` entries), add these as additional entries in the `hooks` array for that
event, rather than replacing what's there — Claude Code runs every hook under a
matching event, so they coexist fine.

**Don't drop the `"async": true` on the `AskUserQuestion` hook.** `PreToolUse`
hooks block the tool call — including the question dialog actually appearing on
your screen — until every hook for that event finishes. Without `async: true`,
the question wouldn't show up until our up-to-30-second grace period elapsed,
every single time. Learned that one the hard way.

If you want the optional desktop notification too (macOS only), add a sibling hook
entry using `terminal-notifier` — it's a one-line addition to the same hook array:

```json
{
  "type": "command",
  "command": "terminal-notifier -message \"Permission required in $(basename \"$(git rev-parse --show-toplevel 2>/dev/null || pwd)\")\" -sound Glass -title \"Claude Code\""
}
```

### 5. Test it

Trigger any permission prompt (e.g. ask Claude to run a command that isn't already
allowlisted). You should get a push with Approve/Approve All/Deny buttons within
about 30 seconds (immediately, if you don't answer on the computer first). Then
have Claude ask you a multiple-choice question and confirm you get a plain push
for that. Then trigger a normal task completion and confirm that push arrives too.

## Customizing

`GRACE_MS` near the top of `permission-approve.js` and `ask-question-notify.js`
controls how long each waits/watches before pushing, in case you answer at the
computer first. For `permission-approve.js` it must stay comfortably under the
hook's `timeout` (600s in the snippet) minus `TIMEOUT_MS` (9 minutes) — the
defaults leave ~30s of margin. `TIMEOUT_MS` itself is how long the phone push
waits for a tap before giving up and falling back to the terminal prompt.

## How it works, briefly

- `PermissionRequest` is a hook event that fires before a tool call executes and
  can return an allow/deny decision, blocking the tool call until it does (or
  times out) — that's why `permission-approve.js` is allowed to block for minutes.
- `PreToolUse` also blocks the tool call by default, but `ask-question-notify.js`
  doesn't need to return any decision, so it's marked `async` to run in the
  background instead of delaying the question.
- Both scripts first watch the session transcript (path given to the hook as
  `transcript_path`) for evidence the pending tool call already got a result —
  which only happens if you answered it some other way (e.g. in the terminal) —
  and skip the phone push entirely if so. Matching is intentionally loose about
  extra/missing keys, since Claude Code fills in tool-schema defaults (like
  `AskUserQuestion`'s `multiSelect: false`) before handing input to hooks, but
  the transcript keeps whatever the model actually emitted.
- For permissions, once resolved, it outputs a JSON decision
  (`{"hookSpecificOutput": {...}}`) that Claude Code reads to allow/deny the call.
  The question notifier never outputs a decision — it's a pure side effect.

## Security notes

- Keep your ntfy topic private — treat it like a password. Anyone with it can
  see your notifications and tap Approve/Deny on your behalf.
- "Approve All" only ever persists an **exact-match** rule (the literal command,
  file path, or domain) — never a wildcard — specifically so it can't end up
  auto-approving something broader than what you actually approved.

## License

[MIT](LICENSE)
