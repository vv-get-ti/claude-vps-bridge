# Windows workspace

Claude Code and its login run on this VPS. The selected project, its files, programs, GPU and other agents are on Windows (`WINDOWS_PROJECT_CWD`). Every request is bound to that project; never substitute another one.

## Calling it

Bash is only a transport. Send one command with one single-quoted JSON object:

    windows-workspace '{"action":"read","path":"README.md"}'

- No pipes, redirection, `$()` or Linux commands. Native Read works only for images/PDFs staged by `media` and for this session's saved tool output; other native file tools are disabled.
- Write a single quote inside the JSON as `\u0027`. Keep PowerShell scripts as written; do not restructure them around quoting.
- Do not pass `cwd`, `projectId` or `sessionId`; they are added automatically.
- Short forms for inspection: `windows-workspace read 'src/a.ts' --offset 0 --limit 100`, `search '.' --pattern 'text'`, `list '.'`, `status`.
- `{"action":"batch","requests":[...]}` runs up to 20 independent read/list/search/info requests in one call.

## Operations

| action | use |
|---|---|
| `read` / `list` | file content with sha256 and paging; directory listing |
| `search` | literal search; continue with `searchId` + `nextOffset` until `hasMore` is false |
| `write` / `edit` | need the current sha256 as `expectedHash` (`absent` for a new file); `edit` replaces one exact, unique match |
| `run` | PowerShell 7 `script`, or `executable` + `args`; unique `requestId`; optional `workingDirectory`, `waitMs` ≤ 30000, `artifacts` |
| `job` / `jobs` | `status`, `cancel`, or `output` paged by byte offset; read output instead of rerunning a command |
| `media` | send an image/PDF (≤ 5 MiB) for native Read; a video returns its path and size only |
| `artifact` | verify an output file and get Markdown to include in your answer |
| `capability` | read a local Skill/command/agent definition (`skill:name`) and its files |
| `isolation` | Git worktree for explicitly authorized parallel coding; `apply` only fast-forwards |
| `agent` | official CodexHost CLI argv (`harness`, `delegate`, `thread`) |
| `info` / `status` / `context` | project, rules, permission mode, compatibility and task state |

## Rules that matter

- Project rules (`CLAUDE.md`, `AGENTS.md`, `.claude/rules`) arrive at turn start; a deeper rule arrives the first time you touch its directory. A write that meets a new rule is refused once so you can read it first.
- A `requestId` is idempotent. If a start or write is uncertain, query the same id; never retry under a new id or replay work.
- A finished command is not proof of success: check `exitCode` and the real output.
- Managed writes and commands share one writer lock per project. A delegated agent holds it until you read or wait on its thread.
- Delegate only when the user asks, with an explicit harness id and native defaults. Reading a thread is not delegation; say so when you only read.
- In plan mode, writes, programs and delegation are refused.
- Run Skill scripts on Windows with `run`; never execute `!` substitutions on the VPS. If a Skill needs a tool this bridge lacks, name it.
- You choose tools and processing methods (for example ffmpeg for video). The bridge only transports.
- Files outside the project need an explicit user request.
- Local provider, credential and model settings stay on Windows by design. Do not announce routine configuration loads.

## PowerShell

- In a double-quoted string, write `${name}:` when a colon follows a variable; `"$name:"` is a parse error.
- Quote Git revisions that contain braces, e.g. `git rev-parse "main^{tree}"`; bare `{...}` is a script block.
- `$LASTEXITCODE` only reflects the last native program; check it right after each one, and keep `$ErrorActionPreference = "Stop"` for cmdlets.
- To run a script on another machine over SSH, pipe it on stdin (`` ($s -replace "`r","") | ssh host "bash -s" ``) instead of nesting quotes in one line.

## MCP
`tavily` searches the web directly. `playwright` drives a separate Chrome on Windows: its localhost is Windows, it has none of the user's logins, and its files are under `.claude-vps/browser`. Close the browser when done. If one MCP server fails, report that server's error only.
