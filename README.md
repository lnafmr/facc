# facc — Fake API Claude Code

Exposes an **Anthropic Messages-compatible API** (`POST /v1/messages`) backed by
an **interactive Claude Code session** driven inside a PTY. Because the session
is interactive (not `claude -p`), responses are billed against your
**subscription** (Pro/Max) rather than the API. Useful to let a client library
(Anthropic SDK, a third-party app…) talk to Claude without consuming API credits.

> ⚠️ **Read the [Disclaimer](#disclaimer) before using.** This tool repurposes a
> Claude subscription as an API backend, which likely violates Anthropic's terms.

```
Client (Anthropic SDK / curl)
        │  POST /v1/messages   (Anthropic shape)
        ▼
   server.mjs ──── injects the prompt into the PTY
        │                       │
        │                       ▼
        │            interactive `claude` session  (subscription)
        │                       │ answers, then ends its turn
        │                       ▼
        │   Stop hook (http) ── POST /_hook/stop {session_id, last_assistant_message, transcript_path}
        ▼                       │
   Anthropic response ◄─────────┘  (text from the hook + usage/stop_reason read from the transcript)
```

## Requirements

- Node.js 18+
- [Claude Code](https://claude.com/claude-code) installed and logged in
  (`claude` on your `PATH`), with an active subscription.

## Installation

```bash
# 1. Clone & install dependencies
git clone https://github.com/lnafmr/facc.git
cd facc
npm install

# 2. (Recommended) Generate an API key — creates .env from .env.example and
#    sets API_KEY, so /v1/messages then requires the `x-api-key` header.
npm run gen-key                 # rotate later with:  npm run gen-key -- --force

# 3. Start the server (listens on port 3066)  —  NOT as root/sudo (see warning)
npm start
```

> ⚠️ **Never run `npm start` as `root`/`sudo`.** The backing Claude Code session
> is launched with permissions bypassed (`--permission-mode bypassPermissions`,
> a.k.a. "dangerously skip permissions"): it can run arbitrary shell commands and
> edit files **unsandboxed**. As root that's a whole-system compromise risk — and
> Claude Code itself refuses to start in bypass mode under root/sudo. Run it as a
> regular, unprivileged user.

Configuration lives in `.env` (copy `.env.example` manually if you skip
`gen-key`) — see [Configuration](#configuration-environment-variables).

## How it works

The crux is **response capture**. Rather than scraping the TUI (ANSI codes,
redraws, no reliable end-of-turn marker), it uses a Claude Code **Stop hook**:

1. The `claude` session is launched with an `http` `Stop` hook (injected via
   `--settings`) pointing at the server's `POST /_hook/stop`.
2. On each request, the server **flattens** `system` + `messages` into a single
   prompt and injects it into the PTY.
3. When Claude finishes its turn, the Stop hook sends the server
   `{ session_id, last_assistant_message, transcript_path }`.
4. The server resolves the pending request: the **text** comes from
   `last_assistant_message`; **usage** and `stop_reason` are read from the
   **JSONL transcript** (the `type:"assistant"` lines are already in Anthropic
   format).

The `session_id` is known up front (`--session-id`), so the hook correlates to
the session unambiguously.

## Endpoints

| Method | Route | Purpose |
|--------|-------|---------|
| `POST` | `/v1/messages` | Anthropic Messages façade (non-streaming + simulated SSE streaming) |
| `POST` | `/_hook/stop` | Internal — receives the `claude` Stop hook |
| `GET` | `/health` | Status (current session, exit code) |

## Usage

### curl

```bash
curl -X POST http://localhost:3066/v1/messages \
  -H "content-type: application/json" \
  -d '{"model":"claude-opus-4-7","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}]}'
```

### Anthropic SDK (just change `baseURL`)

```js
import Anthropic from '@anthropic-ai/sdk';
const client = new Anthropic({ apiKey: 'unused', baseURL: 'http://localhost:3066' });
const msg = await client.messages.create({
  model: 'claude-opus-4-7',
  max_tokens: 1024,
  system: 'Answer in a single word.',
  messages: [{ role: 'user', content: 'Capital of France?' }],
});
console.log(msg.content[0].text);
```

A compatibility test is included: `npm run test:sdk`.

### Streaming

`stream: true` is supported. The underlying turn isn't incremental (the Stop hook
delivers the full answer at once), so the server emulates the Anthropic SSE
protocol: it opens the stream, keeps it alive with empty `ping`s while the turn
runs, then replays the final text as a single `content_block_delta`
(`message_start → content_block_start → content_block_delta → … → message_stop`).
Streaming clients — Anthropic SDK `.stream()`, Hermes interactive / TUI — work out
of the box; the only caveat is that output isn't token-by-token.

### Use with Hermes Agent

[Hermes Agent](https://github.com/nousresearch/hermes-agent) can talk to this
server as its `anthropic` provider. **No Hermes source changes are needed** —
only its config and credentials. Start the mock with an `API_KEY` set (see
[Configuration](#configuration-environment-variables)); the same value is used
below as `<API_KEY>`.

```bash
# 1. Point the base URL at the mock (provider stays `anthropic`)
hermes config set model.base_url http://localhost:3066

# 2. Register the mock's API_KEY as a manual pooled credential
#    (must equal API_KEY from facc/.env)
hermes auth add anthropic --type api-key --api-key <API_KEY> --label local-mock-3066

# 3. Remove the Claude Code OAuth credential from Hermes' pool — otherwise
#    Hermes prefers that OAuth token and the mock rejects it (401 invalid
#    x-api-key). Find it with `hermes auth list`, then remove by label/index.
#    This does NOT touch your Claude Code login (~/.claude stays intact).
hermes auth remove anthropic claude_code
```

**Guard-rail (recommended).** Also add the key to `~/.hermes/.env`:

```ini
ANTHROPIC_TOKEN=<API_KEY>
```

If the pooled credential is ever flagged "exhausted", Hermes falls back to
environment resolution, where `~/.claude/.credentials.json` would otherwise
shadow `ANTHROPIC_API_KEY`. `ANTHROPIC_TOKEN` has top priority and — not being an
OAuth-shaped token — is sent as `x-api-key`, so **every** code path uses your key.

Interactive `hermes` and the TUI send `stream: true`; this server answers with
simulated SSE streaming (see [Streaming](#limitations-mvp)), so they work as-is.
Verify with `hermes auth list` (the `local-mock-3066` entry should be selected,
`←`) and a quick `hermes` chat. The key must **not** look like an OAuth token
(`sk-ant-oat…`), or Hermes would send it as a Bearer token instead of `x-api-key`.

## Configuration (environment variables)

| Variable | Default | Purpose |
|----------|---------|---------|
| `PORT` | `3066` | HTTP server port |
| `CLAUDE_CWD` | current cwd | Working directory of the `claude` session |
| `CLAUDE_MODEL` | (claude default) | Model alias (`opus`, `sonnet`, …) |
| `API_KEY` | (none) | If set, required via the `x-api-key` header |

## Logs

Each `/v1/messages` request is logged to `logs/requests.jsonl` (`ts`, `ok`,
`durationMs`, `model`, `turns`, `lastUser`, `responseText`, `usage`, `error`).
The full raw transcript (text, tool_use, thinking) lives in
`~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`.

```bash
tail -f logs/requests.jsonl
```

## Robustness

- **`--permission-mode bypassPermissions`**: no permission modal that would block
  the turn without firing a Stop hook.
- **`--disallowedTools AskUserQuestion`** + a system-prompt instruction: prevents
  Claude from blocking on an interactive menu. It writes the choices as text
  instead.
- **Auto-restart**: if the `claude` session dies, the server spawns a new one and
  switches over (temporary 503 during the restart).
- **Timeout + abort**: if no Stop hook arrives within 180s, the turn is aborted
  (Esc) and the request fails cleanly.

## Limitations (MVP)

- **Single session, one request at a time**: the interactive session is
  serialized (no parallelism). Concurrent requests are queued.
- **No token-by-token streaming**: `stream:true` is supported (see
  [Streaming](#streaming)), but output isn't incremental — the full text arrives
  in one delta.
- **Local-first**: designed for `localhost`. No auth by default (set `API_KEY`).
- **Honored fields**: `model`, `system`, `messages` (text). `tools` and
  `max_tokens` are not mapped onto the interactive session.
- **Multi-turn**: history is flattened into a single prompt (you cannot re-inject
  past assistant turns into the TUI).

## Files

| File | Purpose |
|------|---------|
| `server.mjs` | HTTP server: `/v1/messages` façade, `/_hook/stop`, `/health`, logs, auto-restart |
| `pty-session.mjs` | Interactive `claude` session (PTY) + prompt injection + hook correlation + queue |
| `anthropic.mjs` | Anthropic request parsing + flattening + response formatting |
| `transcript.mjs` | Extracts the last assistant message (real usage/stop_reason) |
| `test-sdk.mjs` | Validation against the real `@anthropic-ai/sdk` |

## Stack

- `node-pty` (native PTY to drive `claude`)
- `node:http` (no framework)
- Claude Code Stop hook (type `http`) for response capture
- Pure ESM

## Disclaimer

This project is provided **for educational and experimental purposes**, as-is,
with no warranty (see [LICENSE](LICENSE)).

It drives a **Claude Code subscription** session and exposes it as an API. Using
a consumer subscription as an API backend — to avoid API billing, or to share /
resell access — **likely violates Anthropic's Terms of Service and Usage
Policies**, and may result in **account suspension or termination**. You are
solely responsible for how you use this software and for compliance with
Anthropic's terms.

**Security warning:** the underlying session runs with
`--permission-mode bypassPermissions`, which lets Claude Code execute shell
commands and modify files on the host. **Never run it as `root`/`sudo`** — bypass
mode is refused under root by Claude Code, and would otherwise be a whole-system
compromise; use a regular, unprivileged user. **Never expose this server to the
public internet** without strong authentication, tool restrictions, and
sandboxing — doing so is effectively remote code execution on your machine. Run
it locally or on a trusted, isolated host only.

## License

[MIT](LICENSE) © lnafmr
