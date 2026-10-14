# hindsight-dsh

Long-term project memory for **DeepSeek Harness** (`dsh`), as a self-contained Cordis plugin with
its own settings page.

It remembers what a repository did, decided and learned — and gives it back to the agent as recall
on the first prompt of a session, as a knowledge preamble, and as a set of `hindsight_*` tools. The
memory engine is [Hindsight](https://github.com/vectorize-io/hindsight); this package is the dsh face
of it, and carries its own pinned copy of the engine's coding-agent runtime — see
[Vendored runtime](#vendored-runtime).

- **One install, no config files.** The plugin carries a settings page (**Settings → Hindsight**), so
  the endpoint, the mode and the memory behaviour are set inside dsh rather than in
  `~/.hindsight/coding-agent.json`.
- **Self-contained.** `dist/host.js` inlines the whole memory runtime, including Schemastery and the
  Hindsight client; the package has **zero runtime dependencies**, so nothing has to resolve inside a
  profile.
- **Never blocks the host.** Every lifecycle listener fails open, and so does plugin binding: a
  failure disables memory and writes one line to the plugin log instead of failing the application's
  boot.
- **Local by default.** A fresh profile starts in `daemon` mode, which runs a Hindsight server on the
  machine, so no account is needed.

## Requirements

| | |
|---|---|
| `dsh` | 0.2.0-rc.2 or newer (`engines.dsh`) |
| Node | 20+ |
| `uv` / `uvx` | only for the default `daemon` mode — it runs `hindsight-embed`. Install with `curl -LsSf https://astral.sh/uv/install.sh \| sh`, or point the plugin at a server you run. On macOS the plugin finds it in `~/.local/bin` even though a GUI-launched dsh never reads your shell's `PATH`. |
| Homebrew's `openssl@3` | only for the default `daemon` mode on macOS: the embedded PostgreSQL links `/opt/homebrew/opt/openssl@3/lib/libssl.3.dylib`. `brew install openssl@3` (see [brew.sh](https://brew.sh)). Without it the daemon starts and its database does not, with `Library not loaded: libssl.3.dylib` in `~/.hindsight/profiles/<profile>.log`. |

## Install

**From npm** (published package route — installs into one profile through pnpm):

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

**Manual** (any profile, no package manager): add the row to that profile's `cordis.patch.yml`:

```yaml
- insert:
    - id: hindsight
      name: "hindsight-dsh"
```

`name` must be the **bare package name**. The client module system resolves a row's specifier and
reads the nearest `package.json` whose `name` matches, and its parser accepts only `<pkg>` or
`@scope/<pkg>` — a row written `hindsight-dsh/dsh` loads the host half and then silently never serves
the browser half, so no settings page appears. `src/package-contract.test.ts` guards this.

## Configure

Open **Settings → Hindsight**. Everything is saved through the profile's own config patch, so it
survives restarts and applies to every session of that profile.

### One-click setup

Local memory needs a runtime (`uv`), a model for the local server to extract facts with, and the
server itself running. The page's first card covers all three with one button, because none of them
is a decision the user should have to make:

1. **Runtime** — `uv` is located the way the shell would have, and installed with the vendor's own
   installer when it is missing entirely.
2. **Model** — resolved from the page's own fields, then the environment, then **the provider dsh is
   already using**, and finally the Claude Code CLI (which needs no key). The fourth case is the
   point: a user with dsh working already has an endpoint, a model and a key, and the one-click
   setup reads that configuration (`llm.listProviders()` + `settings.describe()`) and resolves the
   credential behind its reference (`credentials.resolve()`). The key goes into the local server's
   process environment — never to the browser, the settings document, the status or a log.
3. **Service** — the detached starter is launched, and `/health` is polled until it answers.

The card then reports what happened: ready, with the service URL and the model it chose; or failed,
with the reason and a retry. Progress is written into the plugin's own `setupStatus` settings field,
which the page reads through the same subscription it already has; the request travels the other way
in `setupRequest`, and the host clears it when it accepts. Both are volatile and internal — the
`setupStatus` write is what lets the panel show a cold start that outlives the page.

A profile pointed at `self-hosted` or `cloud` shows the same card with a button that switches to the
local service and sets it up. Everything below is optional.

| Field | Default | Meaning |
|---|---|---|
| Memory enabled | on | Off leaves sessions unmemoried and registers no tools. |
| Where memory lives | Local daemon | `daemon` starts a local server on demand; `self-hosted` talks to a server you run; `cloud` talks to Hindsight Cloud. |
| API URL | — | Ignored in daemon mode. Blank uses the mode's default. |
| API token | — | Bearer token when the server wants one. Stored in the profile config, never sent back to a browser; blank keeps the stored one. |
| Daemon port | 9077 | The local daemon's port. A healthy server already there is adopted. |
| uv directory | — | Where `uv`/`uvx` live, when dsh cannot find them. Blank searches the usual install locations (`~/.local/bin`, `~/.cargo/bin`, Homebrew). |
| Provider / Base URL / Model / API key (local server) | — | The model the LOCAL server extracts facts with, when you would rather name it than let the one-click setup resolve it. Blank leaves the resolution above in charge. |
| First prompt receives | A reflect synthesis | `reflect`, `pages`, `recall` or `nothing`. |
| Write sessions back | on | Store each completed exchange. |
| Survive context compaction | on | Keep what compaction removes recoverable. |
| Offer removed detail back as | A short pointer | `nothing`, a pointer naming the span, or the recovered text. |
| Retain code changes | off | One code-grounded fact per turn that changed files. Costs an extraction per changed turn. |
| Seed cold repositories | on | Seed a repository's bank from git history on its first session. |
| Only opted-in repositories | off | With it on, an unlisted directory leaves no trace. |
| Shared bank id | — | One bank for every repository. Blank = one bank per repository. |
| Per-repository bank name | `coding-agent::{gitProject}` | Placeholders: `{gitProject} {project} {harness} {channel} {user}`. |
| Log level | info | Verbosity, in `~/.hindsight/coding-agents-logs`. |

**Precedence.** The settings page is the highest layer, above `HINDSIGHT_*` environment variables and
above `~/.hindsight/coding-agent.json`. A text field left blank is *omitted* rather than written as
empty, so the file still supplies endpoints, tokens and bank ids the page does not name — you can keep
the shared file for other harnesses and set only what you want dsh to differ on. To make the shared
file win for a field, clear the page's value (the field's "Reset" badge).

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

- The **host half** contributes the Loader row, a `Config` schema of `.volatile()` fields, and the
  binding of dsh's lifecycle events (`agent/created`, `agent/pre-step`, `agent/turn-stopping`,
  `agent/disposed`, `session/event`) onto the shared Hindsight runtime. It reads its config from the
  **second argument** Cordis passes to `apply(ctx, config)` — *not* `ctx.config`, which is not a
  service and throws `cannot get property "config" without inject`. Each volatile field arrives as a
  live reference; `readSettings` unwraps them at read time, which is what makes a value saved a
  moment ago the value in force.
- The **browser half** registers one page into the settings panel's `settings.section` slot, and only
  while the Host actually serves this plugin's settings namespace. Text, number and secret controls go
  through the host UI library's own `SettingsFormModel`/`SettingsForm`, which render their own label,
  hint, override badge and separator — so they are never wrapped in a label of this page's own.
  Switches and selects have no descriptor in that library, so they are staged in the controller and
  drawn to the same metrics as a field primitive (13px/500 label, 12px tertiary hint, 12px vertical
  padding, and the input's own height, radius, border and fill); that shared metric is what keeps
  twenty controls looking like one list instead of two kits. Groups are cards, and the page is one
  column, because the panel gives it roughly 564px beside its navigation.
- **One dsh process serves several repositories**, and memory is per-repository, so a runtime core is
  built per session workspace rather than per process. A volatile write does not remount the plugin
  (that would tear down every live session's core), so the plugin listens for the write and drops the
  cached workspaces; the next event rebuilds them against the saved values.

The runtime itself lives in
[`hindsight-integrations/coding-agents`](https://github.com/vectorize-io/hindsight/tree/main/hindsight-integrations/coding-agents),
where twenty harnesses share it; this package carries a pinned copy of that source and bundles it, so
the two never drift apart silently. Only the extra configuration seam (`loadConfig({ overrides })`
and `setRuntimeConfigSource`) is shared with the other harnesses.

## Vendored runtime

`vendor/coding-agents/` is a pinned copy of the shared coding-agent runtime — 73 source files plus a
generated `package.json`, taken from `hindsight-integrations/coding-agents`, and the only thing
`dist/host.js` is built from. Upstream is the single source of truth for the code; this repository is
the single source of truth for what it builds against.

It is a copy rather than a dependency for a reason. The runtime is *bundled*, not resolved: an install
must be a link and a copy, with nothing for a profile's module system to look up, and no version of a
shared package able to drift under a user between two plugin releases. A versioned dependency would
put a resolution step and a drifting third party back in that path.

The cost of a copy is that it can fall behind, so one script owns the whole relationship:

```sh
pnpm run sync-runtime --from ../hindsight        # take a new copy; records the upstream revision
pnpm run check-runtime                           # verify the copy; no checkout needed
```

`sync-runtime` copies the file set, regenerates `vendor/coding-agents/package.json` (the runtime reads
its `version` for the `User-Agent` it sends the server), and writes `vendor/VENDOR.json`: the upstream
package, version and commit, plus a content hash of **everything under `vendor/coding-agents/`** —
sources and the generated manifest alike, since an edit to either changes what this package claims to
be. Re-syncing an unchanged upstream rewrites nothing, so a no-op sync stays a no-op in `git status`.
CI runs `check-runtime` with no checkout available, so a hand-edited or half-synced tree fails there
instead of surfacing later as a puzzling typecheck or bundling error.

Three invariants are enforced, because each fails silently otherwise:

- **The set is closed.** No vendored file may import anything outside it. The boundary is proved
  against the upstream text *before* a byte is written, so a sync that would produce a broken tree
  leaves the working tree exactly as it found it, and names the offending file.
- **Every package the bundle needs is declared.** `scripts/build.mjs` reads its own resolved import
  graph and fails if the runtime reaches for a package `package.json` does not list. That is what
  makes a re-sync tell you exactly what to add, instead of failing at a user's first prompt.
- **Everything the runtime reaches for by path is built.** Four of the bundled entries are never
  imported — the runtime spawns them as siblings by `dirname(import.meta.url)`, usually with stdio
  ignored, so a missing one is a feature that silently never happens rather than an error.
  `pnpm run check-contract` reads the vendored source for that pattern and fails if a spawn target is
  not one of the build's entries, which is how an upstream addition announces itself.

Vendoring is deliberately *not* in the published tarball: `files` ships only the built bundles, so
these sources exist for maintainers and CI, not for users. `check-contract` asserts that too.

## Development

```sh
pnpm install
pnpm run build           # dist/host.js (host, self-contained) + lib/client.js (browser, loader envelope)
pnpm test                # unit tests; no dsh needed
pnpm run typecheck
pnpm run check-runtime   # the vendored runtime still matches vendor/VENDOR.json
pnpm run check-contract  # after a build: the manifest, the artifacts and `files` agree
```

**If `pnpm test` dies with `Cannot find native binding`** — a `rolldown` error naming
`@rolldown/binding-wasm32-wasi` — the Node you are running is code-signed, and macOS refuses to load
the adhoc-signed native addon into it:

```
code signature ... not valid for use in process: mapping process and mapped file
(non-platform) have different Team IDs
```

dsh's own bundled Node is signed this way, so this is the normal case when you are testing inside the
application rather than a shell. Install the runtime's WebAssembly fallback, which needs no signature.
The fallback must match the `rolldown` that `vitest` resolved, which is not a direct dependency here:

```sh
ROLLDOWN=$(node -p "require(require.resolve('rolldown/package.json',{paths:[require.resolve('vitest/package.json')]})).version")
pnpm add -D "@rolldown/binding-wasm32-wasi@$ROLLDOWN"
```

CI does not need this — GitHub's Linux runners load the native binding — so it is deliberately not a
committed dependency. Add it locally, and `vitest` picks it up on its own.

**Acceptance test against a real dsh.** The unit tests use doubles for the application's UI library
and the Cordis context, which is exactly how a plugin passes its tests while failing to load. Boot a
scratch instance before trusting it — this cannot touch the profile you actually use:

```sh
export DSH_HOME=/tmp/dsh-scratch
DSH_BIN="/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"
CLI="/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js"
run() { ELECTRON_RUN_AS_NODE=1 "$DSH_BIN" --expose-internals "$CLI" "$@"; }

run plugin --profile hsw add "$PWD"           # install into the scratch profile
HINDSIGHT_LOG_FILE=/tmp/dsh-scratch/plugin.log run --profile hsw --port 18477 &
```

Then confirm, in order:

1. `plugin.log` contains `[dsh] memory plugin bound` — the host half bound without throwing.
2. The served index contains a client row for this package (fetch `/` with the printed `?token=…`):
   `grep -o 'hindsight-dsh/client.js' index.html`.
3. The combo URL from that row returns the bundle: `curl -b cookies '<…>/plugins/??hindsight-dsh/client.js&rev=<rev>'`.

## Publish

```sh
pnpm run build && npm publish
```

`files` ships `dist`, `lib`, `cordis.patch.yml` and this README — not `vendor/` or `src/`, which are
build-time only. The package has no dependencies, so an install is a link and a copy. Bump `version`,
and keep `engines.dsh` in step with the dsh release the plugin has been tested against.

Because the runtime is inlined at build time, a published bundle is frozen against the revision in
`vendor/VENDOR.json`. To ship a runtime fix from upstream, re-sync, rebuild and publish:

## Troubleshooting

### macOS without Homebrew

The embedded PostgreSQL needs OpenSSL 3, and `pg0` looks for it at Homebrew's path. If you would
rather not install Homebrew — or cannot reach its installer — relocate a bottle into your own home
and repoint the two references. No root, no Homebrew, and deleting `~/.pg0` undoes it (pg0 downloads
a fresh copy):

```sh
TAG="arm64_tahoe"           # `sw_vers -productVersion` decides this: 26→tahoe, 15→sequoia, 14→sonoma
DEST="$HOME/.local/opt/openssl3/lib"; mkdir -p "$DEST"
curl -L "https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles/bottles/openssl%403-3.5.9.$TAG.bottle.tar.gz" \
  | tar xz -C /tmp --strip-components=1
cp /tmp/lib/libssl.3.dylib /tmp/lib/libcrypto.3.dylib "$DEST/"
install_name_tool -id "$DEST/libcrypto.3.dylib" "$DEST/libcrypto.3.dylib"
install_name_tool -id "$DEST/libssl.3.dylib" "$DEST/libssl.3.dylib"
install_name_tool -change "@@HOMEBREW_CELLAR@@/openssl@3/3.5.9/lib/libcrypto.3.dylib" "$DEST/libcrypto.3.dylib" "$DEST/libssl.3.dylib"
codesign --force --sign - "$DEST/libcrypto.3.dylib" "$DEST/libssl.3.dylib"

# Repoint every pg0 binary/dylib that names the Homebrew path, re-signing each one (arm64 refuses
# to execute a Mach-O whose signature install_name_tool just invalidated).
for f in "$HOME"/.pg0/installation/*/bin/* "$HOME"/.pg0/installation/*/lib/*.dylib; do
  otool -L "$f" 2>/dev/null | grep -q "/opt/homebrew/opt/openssl@3/lib" || continue
  install_name_tool \
    -change /opt/homebrew/opt/openssl@3/lib/libssl.3.dylib "$DEST/libssl.3.dylib" \
    -change /opt/homebrew/opt/openssl@3/lib/libcrypto.3.dylib "$DEST/libcrypto.3.dylib" "$f"
  codesign --force --sign - "$f"
done
```

Then start the daemon and check `/health` reports `"database":"connected"`.



| Symptom | Cause |
|---|---|
| No Settings → Hindsight page | The browser half was not served. Check the Loader row names the bare package (see Install), and that `lib/client.js` is in the installed package. |
| `hindsight: memory disabled — the plugin failed to bind` in the log | The host half threw while binding; a bug in the plugin, reported instead of failing the app's boot. |
| Daemon mode never answers | `uv`/`uvx` is not on `PATH` (install it, or use `self-hosted`), or its embedded PostgreSQL cannot load Homebrew's OpenSSL on macOS (`brew install openssl@3`), or no model is configured for the local server. The daemon's own log is `~/.hindsight/profiles/<profile>.log`. |
| Page shows *This plugin is not loaded* | The Host is not serving the settings namespace: the Loader row is disabled or failed. |

The plugin's log is `~/.hindsight/coding-agents-logs/plugin.log` (override with
`HINDSIGHT_LOG_FILE`), and it starts with one line per process naming the mode in force.

To disable without uninstalling, add this to the profile's `cordis.patch.yml`:

```yaml
- id: hindsight
  disabled: true
```

To remove: `dsh plugin --profile <profile> remove hindsight-dsh`.
