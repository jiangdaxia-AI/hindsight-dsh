# hindsight-dsh

[![test](https://github.com/jiangdaxia-AI/hindsight-dsh/actions/workflows/test.yml/badge.svg)](https://github.com/jiangdaxia-AI/hindsight-dsh/actions/workflows/test.yml)

**Long-term project memory for DeepSeek Harness (`dsh`)** — a self-contained Cordis plugin with its
own settings page.

[English](README.md) · [简体中文](README.zh-CN.md)

A repository has a memory: what it did, what it decided, what it learned the hard way. `hindsight-dsh`
gives that memory to the coding agent — as recall on the first prompt of a session, as a knowledge
preamble, and as a set of `hindsight_*` tools. The memory engine is
[Hindsight](https://github.com/vectorize-io/hindsight); this package is the dsh face of it, and owns
the coding-agent runtime it runs on.

## Why this exists

An agent starts every session knowing nothing about the repository it is about to change. The usual
answers are a hand-written `AGENTS.md` (stale by Thursday) and a long `git log` (unreadable at
scale). Memory should be a service: written on every turn, extracted into facts and knowledge pages
by a model, and retrieved on demand — without the user ever configuring a memory file.

- **One install, no config files.** The plugin carries a settings page (**Settings → Hindsight**), so
  the endpoint, the mode and the memory behaviour are set inside dsh rather than in
  `~/.hindsight/coding-agent.json`.
- **Self-contained.** `dist/host.js` inlines the whole memory runtime, including Schemastery and the
  Hindsight client; the package has **zero runtime dependencies**, so nothing has to resolve inside a
  profile.
- **Never blocks the host.** Every lifecycle listener fails open, and so does plugin binding: a
  failure disables memory and writes one line to the plugin log instead of failing the application's
  boot. Recall is bounded by `reflectPatienceMs`, so a slow synthesis is delivered on a later step
  rather than waited for on the critical path.
- **Local by default.** A fresh profile starts in `daemon` mode, which runs a Hindsight server on the
  machine, so no account is needed.
- **Visible.** `/hindsight` and `hindsight-dsh` report which bank a repository resolves to, what is
  in it, and whether it is healthy — read-only, without spending a model turn.

## Requirements

| | |
|---|---|
| `dsh` | 0.2.0-rc.2 or newer (`engines.dsh`) |
| Node | 20+ |
| `uv` / `uvx` | only for the default `daemon` mode — it runs `hindsight-embed`. Install with `curl -LsSf https://astral.sh/uv/install.sh \| sh`, or point the plugin at a server you run. |
| Homebrew's `openssl@3` | only for `daemon` mode on macOS: the embedded PostgreSQL links `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`. `brew install openssl@3` ([brew.sh](https://brew.sh)). |

## Install

**From npm** (installs into one profile through pnpm):

```sh
dsh plugin --profile <profile> add hindsight-dsh
```

The package declares `dsh.bundle.patch`, so the profile picks the Loader row up automatically;
nothing else needs editing. Restart, or let a running dsh apply the change through its config watcher.

**From a checkout** (development):

```sh
pnpm install && pnpm run build
dsh plugin --profile <profile> add "$PWD"
```

**Manual** (any profile, no package manager) — add the row to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: hindsight
      name: "hindsight-dsh"
```

`name` must be the **bare package name**. A row written `hindsight-dsh/dsh` loads the host half and
then silently never serves the browser half, so no settings page appears.

## Quick start

Open **Settings → Hindsight**. The first card sets up local memory with one button:

1. **Runtime** — `uv` is located the way the shell would have, and installed with the vendor's own
   installer when it is missing entirely.
2. **Model** — resolved from the page's own fields, then the environment, then **the provider dsh is
   already using**, and finally the Claude Code CLI (which needs no key). The key goes into the local
   server's process environment — never to the browser, the settings document, the status or a log.
3. **Service** — the detached starter is launched, and `/health` is polled until it answers.

The card then reports what happened: ready, with the service URL and the model it chose; or failed,
with the reason and a retry. A profile pointed at `self-hosted` or `cloud` shows the same card with a
button that switches to the local service and sets it up.

> **Use a flash model.** Fact extraction and consolidation are frequent, short-context calls, so a
> cheap, fast **flash-series** model is the right choice — `qwen3.8-flash`, `hy4-flash`, and the
> like. Name one in the local server's model field, or leave it blank to follow the model dsh is
> already using. A flagship model costs more per turn and buys little on extraction.

## Configure

Everything is saved through the profile's own config patch, so it survives restarts and applies to
every session of that profile.

| Field | Default | Meaning |
|---|---|---|
| Memory enabled | on | Off leaves sessions unmemoried and registers no tools. |
| Where memory lives | Local daemon | `daemon` starts a local server on demand; `self-hosted` talks to a server you run; `cloud` talks to Hindsight Cloud. |
| API URL | — | Ignored in daemon mode. Blank uses the mode's default. |
| API token | — | Bearer token when the server wants one. Stored in the profile config, never sent back to a browser; blank keeps the stored one. |
| Daemon port | 9077 | The local daemon's port. A healthy server already there is adopted. |
| uv directory | — | Where `uv`/`uvx` live, when dsh cannot find them. Blank searches the usual install locations. |
| Provider / Base URL / Model / API key | — | The model the **local** server extracts facts with, when you would rather name it than let the one-click setup resolve it. |
| First prompt receives | A reflect synthesis | `reflect`, `pages`, `recall` or `nothing`. |
| Write sessions back | on | Store each completed exchange. |
| Survive context compaction | on | Keep what compaction removes recoverable. |
| Retain code changes | off | One code-grounded fact per turn that changed files. |
| Seed cold repositories | on | Seed a repository's bank from git history on its first session. |
| Only opted-in repositories | off | With it on, an unlisted directory leaves no trace. |
| Shared bank id | — | One bank for every repository. Blank = one bank per repository. |
| Per-repository bank name | `coding-agent::{gitProject}` | Placeholders: `{gitProject} {project} {harness} {channel} {user}`. |
| Log level | info | Verbosity, in `~/.hindsight/coding-agents-logs`. |

**Precedence.** The settings page is the highest layer, above `HINDSIGHT_*` environment variables and
above `~/.hindsight/coding-agent.json` — but only from its **first save**. Until you save the page
once, it projects *nothing*: a hand-configured shared file stays in force untouched. After the first
save, a text field left blank is *omitted* rather than written as empty, so the file still supplies
endpoints, tokens and bank ids the page does not name.

**The two reflection budgets** are deliberately not on the page — they are measurements about your
model route, not preferences. Both live in `~/.hindsight/coding-agent.json` (or as
`HINDSIGHT_REFLECT_PATIENCE_MS` / `HINDSIGHT_REFLECT_TIMEOUT_MS`):

| Key | Default | Meaning |
|---|---|---|
| `reflectPatienceMs` | 5000 | How long one step waits for that session's synthesis of the bank's history. After that the step is answered from a knowledge-page search and the synthesis is left running. `0` never waits. |
| `reflectTimeoutMs` | 20000 | How long the synthesis may take to *succeed*. A slow model route needs this in the minutes. |

## How it works

```
dsh host                                    browser
┌───────────────────────────────┐          ┌──────────────────────────────┐
│ hindsight-dsh  (dist/host.js) │          │ hindsight-dsh (lib/client.js) │
│  Config  ← Schemastery schema │          │  Settings → Hindsight         │
│  apply(ctx, config)           │          │  ctx.configForms.get(…)       │
│      │ overrides layer        │          │  ctx.slots → settings.section │
│      ▼                        │          └──────────────┬───────────────┘
│  memory runtime (inlined)     │◄──── settings document ─┘
│  recall · retain · tools      │      (profile cordis.patch.yml)
└───────────────────────────────┘
```

A session flows through memory event by event — every handler is fail-open, so a daemon that is down
costs that one effect, never the turn:

```
session opens ── agent/created ─▶ bank resolved · compaction ledger restored · seed if cold
you send a prompt ── agent/pre-step ─▶ recall within reflectPatienceMs → block injected (deduped)
a slow synthesis lands ── agent/pre-step (any later step) ─▶ injected then, once
model works (may call hindsight_* tools) ── session/event ─▶ ledger folded (O(1) per append)
turn completes ── agent/turn-stopping ─▶ transcript retained · code facts (opt-in)
dsh compacts ── session/event ─▶ dropped spans retained as compaction:<session>:<id>
session closes ── agent/disposed ─▶ in-flight writes drained · per-session state dropped
```

The runtime itself is `vendor/coding-agents/`, forked out of
[`hindsight-integrations/coding-agents`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents)
and now **this package's own source**: a change to it is an ordinary change here, and
`scripts/pin-runtime.mjs` guards that source and re-pins it (`--record`) rather than pulling it from
anywhere.

## Inspecting memory

Memory is otherwise invisible from the outside: the plugin writes to a bank on a server, and the
agent's own `hindsight_*` tools are the only window onto it — the model has to ask. Two front doors
open the same read-only reports to *you*:

- **`/hindsight`** inside dsh (Web client and CLI). It runs against the agent without creating a
  model message, so asking costs no turn and never enters the context the model reasons over.
- **`hindsight-dsh`** from a shell — the same code, for when the thing being debugged is dsh itself.
  `dist/cli.js` is the package's `bin` entry, so `npx hindsight-dsh doctor` also works.

```text
/hindsight                        this repository: resolved bank, records, sync state, log paths
/hindsight banks [--all]          every bank on the server, newest write first
/hindsight bank <bank_id>         one bank: documents, knowledge pages, running extractions
/hindsight documents <bank_id>    the documents themselves: id, last write, provenance tags
/hindsight doctor                 plugin self-check: bind line, daemon, config, logs
```

```console
$ /hindsight
hindsight · dsh memory
  plugin    daemon · http://127.0.0.1:9077 · daemon healthy
  repo      /Users/me/work/api → coding-agent::api
  records   686 facts · 7 documents · 5 knowledge pages · last write 2026-10-14 15:01
  sync      synced · gitlog yes · deepen 12/36 · chats 4 · pages 5 · survey 2 behind · ops 0
  projects  2 bank(s) from this integration, 2 total — /hindsight banks
  config    ~/.hindsight/coding-agent.json
  logs      ~/.hindsight/coding-agents-logs
```

The same listing is on the settings page — **Settings → Hindsight → Project libraries** — where it
also carries the one destructive action the reports deliberately do not: deleting a bank. Only banks
this plugin created (`coding-agent::*`) are listed by default; *Show every library on this server*
widens the list. A count the server cannot answer is shown as `—`, never as `0`.

A machine can have no `node` on `PATH` while dsh ships its own, which is exactly the machine this
plugin is usually debugging on. `scripts/hindsight-dsh` covers that: it runs the same CLI through the
application's binary in Node mode, and prefers a real `node` when one exists.

## Repository layout

| Path | What it is |
|---|---|
| `src/` | The plugin: host half (`host.ts`, `settings.ts`), browser half (`client/`), CLI (`cli.ts`), setup (`uv.ts`, `daemon-llm.ts`). |
| `vendor/coding-agents/` | The coding-agent memory runtime, carried in-tree and inlined at build time. |
| `scripts/` | Build, runtime pinning, and the packaging contract checks. |

## Development

```sh
pnpm install
pnpm run build           # dist/host.js (host) + dist/cli.js (shell reports) + lib/client.js (browser)
pnpm test                # unit tests; no dsh needed
pnpm run typecheck
pnpm run check-runtime   # the runtime still matches vendor/VENDOR.json, and its imports are closed
pnpm run record-runtime  # after a deliberate change to vendor/coding-agents: re-pin it
pnpm run check-contract  # after a build: the manifest, the artifacts and `files` agree
```

A build that needs a package `package.json` does not declare fails here, not at a user's first
prompt. The vendored runtime is *bundled*, not resolved: an install is a link and a copy, with
nothing for a profile's module system to look up.

**Publishing** is `pnpm run build && npm publish`. `files` ships `dist`, `lib`, `cordis.patch.yml`
and this README — not `vendor/` or `src/`, which are build-time only.

## Troubleshooting

| Symptom | Cause |
|---|---|
| No **Settings → Hindsight** page | The browser half was not served. Check the Loader row names the bare package, and that `lib/client.js` is in the installed package. |
| `hindsight: memory disabled — the plugin failed to bind` | The host half threw while binding; a bug in the plugin, reported instead of failing the app's boot. |
| Daemon mode never answers | `uv`/`uvx` is not on `PATH`, or its embedded PostgreSQL cannot load Homebrew's OpenSSL on macOS (`brew install openssl@3`), or no model is configured for the local server. The daemon's own log is `~/.hindsight/profiles/<profile>.log`. |
| A session has no memory but the log looks clean | `hindsight-dsh doctor`: a bind line is written only when the bind **completed**, so its absence (or a `FAILED` line) is the failure itself. |
| The first prompt hangs for a minute, then answers | The awaited `agent/pre-step` is waiting on a reflect synthesis whose model route is slow. A step waits at most `reflectPatienceMs`; raise it only if you accept the latency. |

The plugin's log is `~/.hindsight/coding-agents-logs/plugin.log` (override with
`HINDSIGHT_LOG_FILE`), and it starts with one line per process naming the mode in force.
`node dist/cli.js doctor` prints the same picture without needing dsh to be running.

## License

MIT — see [LICENSE](LICENSE). The memory engine and the vendored coding-agent runtime come from
[Hindsight](https://github.com/vectorize-io/hindsight) (© Vectorize AI, Inc., MIT); the dsh plugin is
© jiangdaxia.
