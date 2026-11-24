/**
 * The host half: this package's Cordis plugin.
 *
 * It is a thin shell around the shared Hindsight runtime, carried in-tree under
 * `vendor/coding-agents` (forked from `hindsight-integrations/coding-agents`; pinned by
 * `scripts/pin-runtime.mjs`). Building the runtime again here would fork it, so the bundle inlines
 * that source instead and this file adds the one thing a packaged integration cannot have: a
 * configuration surface the user can reach from inside dsh.
 *
 * HOW THE TWO HALVES MEET THE RUNTIME. The runtime has always been configured by
 * `~/.hindsight/coding-agent.json`, the file every Hindsight harness shares. `loadConfig` now takes
 * an `overrides` layer above the file and the environment, and `setRuntimeConfigSource` installs one
 * for the life of this plugin. So the page the user just saved is what the next recalled prompt
 * uses, and any field the page does not name still comes from the shared file.
 *
 * WHERE THE CONFIG ARRIVES — and why it is the second argument. Cordis calls a plugin
 * `apply(ctx, config)`, with the config validated against the plugin's `Config` schema. It is NOT
 * `ctx.config`: the context proxy resolves services, and reading a name that is not a service throws
 * `cannot get property "config" without inject` — at load, which fails the whole entry, and on this
 * host a failed entry is enough to stop the application from opening. Every field the schema marks
 * `.volatile()` arrives as a live REFERENCE (`cosmokit`'s `createVolatile`), not as a value: it has
 * `get()` and a `Symbol.for('cosmokit.volatile.write')` setter that the Loader uses to fold a
 * settings write into the running plugin WITHOUT remounting it. `readSettings` unwraps those
 * references, and reading them inside a thunk — rather than once at load — is what makes the values
 * the user saved a moment ago the values in force.
 *
 * WHY the volatile listener. A volatile write updates those references in place, so nothing
 * re-reads the config on its own. Cached per-repo workspaces close over the endpoint, bank and
 * opt-out they were built with, so the listener drops them; the next event rebuilds against the
 * values that were just saved. Remounting instead would be worse than useless: it would tear down
 * the memory cores of every live session.
 */
import {
  apply as applyHindsight,
  inject as runtimeInject,
  setRuntimeConfigSource,
} from "../vendor/coding-agents/src/dsh";
import { writeFileSync } from "node:fs";
import { HOST_OVERRIDES_ENV, loadConfig } from "../vendor/coding-agents/src/core/config";
import { hasUvx, isServerHealthy, startDaemonDetached } from "../vendor/coding-agents/src/core/daemon";
import { resolveHostMemory } from "../vendor/coding-agents/src/core/host-client";
import { log } from "../vendor/coding-agents/src/core/log";
import { SPAWN_CREDENTIALS_PATH } from "../vendor/coding-agents/src/core/spawn-credentials";
import { registerHindsightCommand, type CommandScope } from "./command";
import { handleLibraryRequest, LIBRARY_ROUTE, type BankAdminDeps } from "./bank-admin";
import { DEFAULT_SETTINGS, NAMESPACE, type DshSettings } from "./fields";
import { HARNESS } from "./harness";
import { inspectDepsOf, type InspectDeps } from "./inspect";
import { Config, toRuntimeConfig } from "./settings";
import { applyDaemonLlmEnv, ensureDaemonProcessEnv, installDaemonLlmEnv, unpinDaemonLlmProfile } from "./daemon-llm";
import { ensureUvOnPath } from "./uv";
import {
  harnessFacts,
  harnessModel,
  harnessModelChoices,
  serviceOf,
  type ServiceLookup,
  type SettingsServiceLike,
} from "./harness-services";
import {
  installUv,
  modelFromChoice,
  needsRestartFor,
  runSetup,
  type DaemonModel,
  type HarnessRouteFacts,
  type SetupDeps,
} from "./setup";
import { parseSetupStatus, serializeSetupStatus, type SetupStatus } from "./setup-types";

/** Cordis plugin name. The Loader entry id is `hindsight`, which is also the settings namespace. */
export const name = "hindsight";

/** The agent registry owns the lifecycle events the runtime binds; without it there is nothing to do. */
export const inject = runtimeInject;

/** How many times one settings write is reissued while the Host's write path is busy. */
const SETTINGS_WRITE_TRIES = 40;
/** The pause between those tries: tens of milliseconds, since the blocking transaction is short. */
const SETTINGS_WRITE_BACKOFF_MS = 100;

/**
 * Every settings write this process issues, one after another.
 *
 * The chain turns a burst of writes into a sequence, so retries cannot interleave and a rejected
 * attempt never orphans the ones queued behind it. Each link swallows its own errors (the writer
 * already logged them), so one failure cannot stall the rest.
 */
let writeChain: Promise<void> = Promise.resolve();

export { Config };

/**
 * The symbol `cosmokit` stamps on a volatile config reference.
 *
 * Taken from the global symbol registry rather than imported, so a reference created by the Host's
 * own copy of the library is recognized here: the check must not depend on module identity, and this
 * package deliberately has no runtime dependencies.
 */
const VOLATILE_WRITE = Symbol.for("cosmokit.volatile.write");

/** A `.volatile()` config field, as the Loader hands it to `apply`. */
interface VolatileRef {
  get(): unknown;
  [VOLATILE_WRITE]?: (value: unknown) => void;
}

/** Whether a config field is one of those live references. */
function isVolatileRef(value: unknown): value is VolatileRef {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { get?: unknown }).get === "function" &&
    VOLATILE_WRITE in value
  );
}

/** The current value of one config field, wrapped or not. */
function live<T>(value: unknown): T | undefined {
  return (isVolatileRef(value) ? value.get() : value) as T | undefined;
}

/**
 * Read the plugin's config, unwrapping every live reference.
 *
 * Exported for the test that proves a value saved through the settings page is the value this
 * plugin would use.
 *
 * @param config - the second argument Cordis passes to `apply`, or anything else.
 * @returns the settings, with absent fields omitted so `toRuntimeConfig` can apply its defaults.
 */
export function readSettings(config: unknown): Partial<DshSettings> {
  if (typeof config !== "object" || config === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    const current = live(value);
    if (current !== undefined) out[key] = current;
  }
  return out as Partial<DshSettings>;
}

/**
 * The token the settings carry, trimmed; undefined when the page has none.
 *
 * The one credential the host half resolves for its children. It never enters the exported
 * overrides layer (see `publishHostOverrides`); this is the value `publishSpawnCredentials` writes.
 */
function apiTokenOf(settings: Partial<DshSettings>): string | undefined {
  const token = settings.apiToken?.trim();
  return token ? token : undefined;
}

/**
 * Record the credential this plugin's own children should carry, in the 0600 file they read at
 * their spawn boundary (see core/spawn-credentials.ts).
 *
 * Best-effort by design: a directory this cannot write is a machine whose shared config already
 * carries the token, and a child that finds no file falls back to its own config sources — the
 * failure mode is the pre-file behaviour, not a crash. Written on every configuration refresh so
 * a cleared page token clears the file too.
 *
 * Exported for the test that proves a cleared setting clears the file.
 */
export function publishSpawnCredentials(apiToken: string | undefined): void {
  try {
    const body = apiToken === undefined ? "" : JSON.stringify({ apiToken });
    writeFileSync(SPAWN_CREDENTIALS_PATH, body, { mode: 0o600 });
  } catch {
    /* best-effort: children fall back to the shared config file */
  }
}

/**
 * The setup request this host has not acted on yet.
 *
 * The page writes a fresh nonce per click, so a CHANGED value is a request and an unchanged one is
 * the last request still sitting in the document. Blank is "nothing asked": the host clears the
 * field once it accepts, and reading that clear as a request would loop.
 *
 * @param previous - the value this host last acted on.
 * @param settings - the config as it stands now.
 * @returns the request to accept, or `undefined` when there is nothing new.
 */
export function pendingSetupRequest(previous: string, settings: Partial<DshSettings>): string | undefined {
  const request = settings.setupRequest?.trim() ?? "";
  return request !== "" && request !== previous ? request : undefined;
}

/** The context surface this wrapper uses. Everything else is the runtime's business. */
interface HostContext {
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  /** Present on a real context; absent on the stubs the tests build. */
  inject?(deps: string[], callback: (child?: unknown) => void): unknown;
  effect?(callback: () => (() => void) | void, label?: string): unknown;
  get?(name: string): unknown;
  /** The plugin's own fiber, which owns the settings presentation policy. */
  fiber?: unknown;
  readonly logger?: { error?: (message: unknown) => void };
}

/**
 * The Host's connection service, to the extent this plugin uses it.
 *
 * Structural, like every other dsh surface this plugin touches: no dsh package is imported at build
 * time, so this half keeps loading against a composition that lacks the service entirely. The
 * `fetch` registry is the carrier-neutral exact-route table the web transport mounts under `/api`;
 * requests that reach a registered route have already passed the Host/Origin fence and the browser
 * session's cookie authentication, which is why the page can call it with a plain same-origin
 * `fetch` and why nothing here checks a credential of its own.
 */
interface ConnectionScope {
  connection?: {
    fetch?: {
      register(route: {
        path: string;
        methods: string[];
        requestBody: "buffered" | "streaming";
        fetch(request: Request): Promise<Response>;
      }): unknown;
    };
  };
  effect?(callback: () => (() => void) | void, label?: string): unknown;
}

/**
 * The escape hatch every settings write goes through.
 *
 * `loader/volatile-update` fires from INSIDE the HMR service's exclusive transaction, and the
 * transaction's AsyncLocalStorage context follows every async continuation of that event: a
 * `setTimeout` retry issued from the handler still reports "HMR transactions cannot be nested"
 * four seconds later, because the storage it checks never cleared. The one context that never
 * carries the transaction is the one a timer created at MODULE LOAD time — the plugin is imported
 * outside any transaction, so the drainer's callbacks stay clean no matter which event asked for
 * the write. The interval holds no state of its own and is unreferenced, so it never keeps the
 * process alive.
 */
const writeQueue: Array<() => void> = [];
setInterval(() => {
  const batch = writeQueue.splice(0);
  for (const run of batch) run();
}, SETTINGS_WRITE_BACKOFF_MS).unref?.();

/**
 * Run one settings write, away from any HMR transaction, serialized behind the last one.
 *
 * WHY THE QUEUE HOP IS THE CONTRACT, not a nicety: a settings write goes through
 * `configEditor.edit`, which serializes itself under the HMR service's exclusive transaction.
 * Issued from the volatile-update handler — with that transaction still running — the write is
 * rejected on the spot with "HMR transactions cannot be nested", and no retry from that same
 * asynchronous chain can ever escape the inherited storage. Hopping onto the module-load timer
 * severs the inheritance; the backoff inside the drainer then only covers ordinary contention
 * with another write already in flight. Writes are also serialized here, so a burst of setup
 * statuses cannot interleave and the last one the page sees is the last one the host produced.
 *
 * @param attempt - the write to perform, as a callable so a retry reissues it.
 * @param label - what the plugin log calls this write when it never lands.
 * @returns when the write landed or the retry budget ran out.
 */
function settleSettingsWrite(attempt: () => Promise<unknown>, label: string): Promise<void> {
  const outcome = new Promise<void>((resolve) => {
    writeQueue.push(() => {
      (async () => {
        for (let tries = 1; ; tries++) {
          try {
            await attempt();
            break;
          } catch (error) {
            if (tries >= SETTINGS_WRITE_TRIES) {
              log.warn(HARNESS, `settings write never landed: ${label}`, { error: String(error) });
              break;
            }
            await new Promise((backoff) => setTimeout(backoff, SETTINGS_WRITE_BACKOFF_MS));
          }
        }
      })().then(resolve, resolve);
    });
  });
  writeChain = writeChain.then(() => outcome, () => outcome);
  return outcome;
}

/**
 * Bind memory, configured by this plugin's own settings page.
 *
 * @param ctx - the Cordis host context.
 * @param config - the resolved Config, as Cordis passes it (see the module comment).
 */
export function apply(ctx: HostContext, config?: unknown): void {
  const source = () => toRuntimeConfig(readSettings(config));
  try {
    setRuntimeConfigSource(source);
    /**
     * Hand this process's resolved layer to every child it spawns — CREDENTIALS EXCEPTED.
     *
     * deepen, the survey supervisor and the survey's MCP server each re-read configuration in
     * their own process, where only the shared file and this environment are visible. The user's
     * choices live in this plugin's settings page, so without this a daemon-mode setup sends every
     * background ingest to the Cloud default and 401s it while the interactive turns keep talking
     * to the local daemon. Refreshed with `source` on every volatile write, so a settings change
     * reaches the next child without a restart.
     *
     * `apiToken` is stripped before the export: this variable travels by INHERITANCE, so every
     * descendant of this host sees it — including the test runners and scripts the AGENT spawns in
     * its sessions, which are not this plugin's to trust with a credential. The token instead goes
     * to a 0600 file the Hindsight children read at their spawn boundary (see
     * `publishSpawnCredentials` below and core/spawn-credentials.ts): a `node -e
     * "process.env.HINDSIGHT_HOST_OVERRIDES"` in any session comes back credential-free.
     */
    const publishHostOverrides = (): void => {
      const { apiToken: _redacted, ...layer } = source();
      process.env[HOST_OVERRIDES_ENV] = JSON.stringify(layer);
      publishSpawnCredentials(apiTokenOf(readSettings(config)));
    };
    publishHostOverrides();
    /** The last setup request this process has acted on; an unchanged value is not a new request. */
    let lastRequest = readSettings(config).setupRequest?.trim() ?? "";
    /** The settings service, once the optional child below has it. */
    let settingsService: SettingsServiceLike | undefined;
    /** Publishes one setup status into this plugin's own settings document. */
    let publish: ((status: SetupStatus) => void) | undefined;
    /** One run at a time: two clicks are one setup, not two daemons racing for the port. */
    let running = false;

    /**
     * The scope dsh's own services answer from, once the injected child below exists.
     *
     * This plugin's own context injects the agent registry alone (the runtime's list), and on a
     * Cordis context a service it did not inject cannot be read off that context at all: the
     * property read throws `cannot get property "llm" without inject` rather than yielding
     * `undefined`, which is the opposite of the "these services are optional" contract
     * `harness-services.ts` documents. `settings`, `credentials` and `llm` are therefore read
     * through the child context `ctx.inject` hands its callback — the one fibre they WERE injected
     * into — and every read tolerates their absence.
     *
     * WHY IT IS LOAD-BEARING: the facts read is what turns into the bind. When it threw off this
     * plugin's own context, the throw landed in the fail-open catch at the bottom of this function,
     * so no hook and no tool was ever registered and every session ran memoryless — with the only
     * trace on the host's console, which keeps no file (2026-10-14).
     */
    let harnessScope: ServiceLookup | undefined;
    /** Where a harness-service read should go: the injected child, or this context until it exists. */
    const harnessLookup = (): ServiceLookup => harnessScope ?? (ctx as ServiceLookup);
    /** dsh's own model facts, or the empty set when this composition cannot produce them. */
    const harnessFactsHere = (): HarnessRouteFacts => {
      try {
        return harnessFacts(harnessLookup());
      } catch {
        return { routes: [], namespaces: [] };
      }
    };

    /**
     * Keep this process's daemon model in step with the page, so EVERY spawn path agrees.
     *
     * The one-click setup applies the model to the environment only when the page asks for a run —
     * so a daemon restarted by a hook, by the plugin reloading, or by hand re-read the profile's
     * `.env` and came back on whatever model was persisted there, silently unpicking the page's
     * choice (2026-10-15: a daemon restarted outside the page came back on an old gateway/model
     * pick while the page showed the local one). Installing the resolved choice into this
     * process's environment closes that: the runtime's `daemonEnv` forwards `HINDSIGHT_API_*` from
     * the environment to the starter, and the starter persists them to the profile — so whichever
     * process starts the daemon next, it starts on the same model.
     *
     * The resolution is the setup's own precedence (the page's pick, then dsh's own model) through
     * the same seams, and `installDaemonLlmEnv` restores what a previous install borrowed, so a
     * CLEARED pick unpins the retired model instead of leaving it standing. `modelFromExplicitEnv`
     * is deliberately absent here: an exported `HINDSIGHT_API_LLM_PROVIDER` is already in the
     * environment and needs no help from us.
     *
     * Fire-and-forget: a volatile write cannot wait on `credentials.resolve`, and the first
     * session's hooks arrive long after one resolution lands. If a hook wins the race, the daemon
     * starts exactly as it would have without this — on the profile's own configuration — and the
     * next refresh installs the choice for the spawn after it.
     */
    /**
     * The model this refresh last installed, so a later one can tell a CLEAR from a no-op.
     *
     * `installDaemonLlmEnv(undefined)` is a valid answer ("nothing resolved"), and the unpin below
     * must not fire for it — only a model that EXISTED and then went away unpins the profile.
     */
    let lastInstalledModel: { provider?: string; model?: string } | undefined;

    const refreshDaemonModelEnv = (): void => {
      void (async () => {
        try {
          await ensureDaemonProcessEnv();
        } catch {
          /* the daemon keeps whatever spawn environment it already had */
        }
        try {
          const model =
            (await modelFromChoice(readSettings(config), harnessFactsHere())) ?? (await harnessModel(harnessLookup()));
          const previous = lastInstalledModel;
          installDaemonLlmEnv(model);
          lastInstalledModel = model ?? undefined;
          // A CLEARED pick must unpick the profile too, not only this process's environment: the
          // starter persists every HINDSIGHT_API_* into the profile's .env, and `--merge` never
          // removes — so without this the next spawn from anywhere else (a hook, a manual
          // `hindsight-embed daemon start`) re-read the retired model while the page showed the
          // new resolution. Only the four variables this plugin ever writes are taken back out;
          // the daemon itself is NOT restarted, because "no model resolved" is not a model change
          // a running service must act on.
          if (model === undefined && previous !== undefined) {
            // The profile name as the running config resolves it — the same resolution the
            // starter uses, so the unpin addresses the profile the next spawn will read.
            unpinDaemonLlmProfile(loadConfig({ harness: HARNESS, overrides: source() }).daemonProfile);
          }
        } catch {
          /* the daemon keeps whatever environment it already had; the page's setup still runs */
        }
      })();
    };
    refreshDaemonModelEnv();

    /**
     * Re-entrancy latch.
     *
     * Reading the harness's facts calls `settings.describe()`, and describe() emits
     * `settings/document-updated` from inside its own construction for any entry whose revision
     * moved. Without the latch that emission would nest the publish inside itself; the host
     * announces the same document again once describe() has returned, so nothing is lost.
     */
    let publishingChoices = false;

    /**
     * Publish the models dsh offers into the settings document, so the page's choice control has
     * its list without ever reading the harness's services from a browser.
     *
     * Skipped when the list is unchanged: this fires on every volatile write and on every document
     * update, and republishing an identical string would churn the document for nothing. An empty
     * read is "the host could not read its own model configuration" rather than "there are none",
     * so it never ERASES a published list — but a real removal (a previous list, now empty) is
     * announced, or clearing dsh's models would leave the pick offering what is gone. Reporting is
     * best-effort by design: a composition whose settings service cannot take the write keeps
     * every other feature, and the page simply offers the follow-dsh default.
     */
    const publishModelChoices = (): void => {
      if (publishingChoices) return;
      publishingChoices = true;
      try {
        const serialized = JSON.stringify(harnessModelChoices(harnessFactsHere()));
        const previous = readSettings(config).modelChoices?.trim() ?? "";
        if (serialized === previous || (serialized === "[]" && previous === "")) return;
        void settleSettingsWrite(
          () => settingsService?.mutate?.(NAMESPACE, [{ op: "set", path: ["modelChoices"], value: serialized }]) ?? Promise.resolve(),
          "publish modelChoices"
        );
      } catch {
        /* the choice list is a convenience; a host that cannot produce it keeps memory working */
      } finally {
        publishingChoices = false;
      }
    };

    /**
     * Refresh the list when the HARNESS's own model configuration moves, not only when the user
     * edits this plugin.
     *
     * `loader/volatile-update` is delivered to the plugin whose own config changed, so a model
     * added, renamed or removed under Settings -> Models never reached this half: the pick kept
     * showing the list published when the plugin loaded (reported as "the model list does not
     * update"). The host announces those writes as `settings/document-updated`, and an adapter
     * appearing or disappearing as `llm/adapters-updated`; both ride the context's shared event
     * bus, so this plugin hears them too. `publishModelChoices` skips an unchanged list, so an
     * unrelated settings write costs one comparison.
     */
    for (const event of ["settings/document-updated", "llm/adapters-updated"]) {
      ctx.on(event, () => publishModelChoices());
    }

    /**
     * The setup's four steps, bound to this host.
     *
     * Read lazily rather than captured: a volatile write updates the config references in place, so
     * the model and the port must be read at the moment the run starts, not when the plugin loaded.
     */
    const setupDeps = (): SetupDeps => {
      const current = () => readSettings(config);
      const resolved = () => loadConfig({ harness: HARNESS, overrides: toRuntimeConfig(current()) });
      return {
        settings: current(),
        env: process.env,
        // The user's pick is resolved against the same facts as the default, so both come from
        // dsh's own configuration — the only place a daemon model may come from now.
        resolveChosenModel: async () => modelFromChoice(current(), harnessFactsHere()),
        publish: (status) => {
          publish?.(status);
          log.info(HARNESS, "local setup", {
            phase: status.phase,
            code: status.code,
            step: status.step,
            ...(status.detail ? { detail: status.detail } : {}),
          });
        },
        ensureUv: (configuredDir) => ensureUvOnPath({ configuredDir }),
        hasUvx,
        installUv: () => installUv(),
        resolveHarnessModel: () => harnessModel(harnessLookup()),
        daemonTarget: () => {
          const cfg = resolved();
          return { apiUrl: cfg.apiUrl, port: cfg.apiPort };
        },
        // The last status records what the RUNNING daemon was started with. When the page has
        // picked something else since, the starter must stop and start it: it only starts on a dead
        // port, so without this the new pick would never reach the daemon while the card claimed it
        // had (the exact shape of #—, reported as "the model text never updates").
        needsRestart: (model: DaemonModel) =>
          needsRestartFor(parseSetupStatus(current().setupStatus)?.service, model),
        startDaemon: (model: DaemonModel | undefined, opts?: { restart?: boolean }) => {
          // The child inherits this process's environment, and the server reads the model from it.
          applyDaemonLlmEnv(model);
          startDaemonDetached(resolved(), HARNESS, undefined, opts);
        },
        healthy: (url, timeoutMs) => isServerHealthy(url, timeoutMs),
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        now: () => Date.now(),
      };
    };

    /** Accept one page request and run the setup for it. */
    const acceptRequest = (): void => {
      if (running) return;
      running = true;
      // Clearing the request IS the acknowledgement, and it keeps a nonce out of the saved profile.
      // Issued through the retrying writer: this runs inside the Host's volatile-update, whose own
      // write transaction is still in flight when this handler fires.
      const acknowledger = settleSettingsWrite(
        () => settingsService?.mutate?.(NAMESPACE, [{ op: "unset", path: ["setupRequest"] }]) ?? Promise.resolve(),
        "clear setupRequest"
      );
      // The setup's status writes queue behind the acknowledgement, so the page sees the request
      // it asked about acknowledged before the first progress line arrives.
      void acknowledger.finally(() => {
        runSetup(setupDeps()).finally(() => {
          running = false;
        });
      });
    };

    // The settings service is optional in the same way the tools registry is: a composition without
    // it loses the page's progress reporting, not memory. `configure({auto:false})` is this plugin's
    // side of the contract for shipping its own page — the harness then never projects a generic
    // form from the Config schema beside it.
    ctx.inject?.(["settings", "credentials", "llm"], (child) => {
      const scope = (child ?? ctx) as HostContext;
      // The one scope these three services are readable from (see `harnessScope`): everything that
      // asks dsh about its own model goes through it from here on.
      harnessScope = scope;
      settingsService = serviceOf<SettingsServiceLike>(scope as never, "settings");
      // The choice list is available the moment the services are, not only after the first save.
      publishModelChoices();
      scope.effect?.(() => {
        settingsService?.configure?.({ auto: false }, ctx.fiber);
      }, "hindsight: own settings page");
      publish = (status) => {
        // Progress writes can be issued while the Host's own transaction is still open (see
        // `settleSettingsWrite`), so they take the retrying writer rather than a plain call.
        void settleSettingsWrite(
          () =>
            settingsService?.update?.(NAMESPACE, { setupStatus: serializeSetupStatus(status) }) ??
            Promise.resolve(),
          "publish setupStatus"
        );
      };
      scope.effect?.(
        () => () => {
          publish = undefined;
        },
        "hindsight: setup reporting"
      );
    });

    /**
     * Everything the `/hindsight` report needs for one directory, resolved when it is asked.
     *
     * `resolveHostMemory` is the runtime's own resolver, so the command answers about the bank a
     * SESSION in that directory writes to — the settings page's endpoint, a `mapPathToBank` /
     * `banks.<id>` route and `optInOnly` included, and read at call time so a field saved a second
     * ago is the one in force. Building the client sends nothing.
     */
    const inspectFor = (directory: string): InspectDeps => {
      const memory = resolveHostMemory(HARNESS, directory, toRuntimeConfig(readSettings(config)));
      // The shared builder, so the command and the CLI cannot drift on what a report's deps are.
      return inspectDepsOf(memory, directory);
    };

    /** Where an asking agent works. dsh records it on the session header; a session without one is
     *  rare, and the process cwd is the honest fallback. */
    const directoryOf = (agent: unknown): string => {
      const session = (agent as { session?: { header?: { cwd?: unknown } } } | undefined)?.session;
      const cwd = session?.header?.cwd;
      return typeof cwd === "string" && cwd !== "" ? cwd : process.cwd();
    };

    // The human-facing surface: `/hindsight`. Optional in the same way the tools registry and the
    // settings service are — a composition without a command registry loses the command, not
    // memory. A plain registration is global, so this one row serves every agent preset.
    ctx.inject?.(["commands"], (child) => {
      registerHindsightCommand((child ?? ctx) as CommandScope, { directoryOf, inspectFor });
    });

    /**
     * Everything the settings page's library list needs, resolved per request.
     *
     * `process.cwd()` rather than a session's directory: the page asks about the whole SERVER, and
     * the directory only decides which bank this process would write to — which the list does not
     * use. It matters in one case, though: with `optInOnly` set, an un-opted directory resolves to
     * "disabled", and the resolved config still carries the endpoint, so the list works there too
     * and the page says memory is off for this process.
     */
    const libraryDeps = (): BankAdminDeps => {
      const memory = resolveHostMemory(HARNESS, process.cwd(), toRuntimeConfig(readSettings(config)));
      return {
        transport: () => memory.client,
        serverMode: () => memory.cfg.serverMode,
        disabled: () => memory.cfg.disabled,
      };
    };

    // WHERE THE PAGE ASKS ABOUT ITS LIBRARIES. The settings document carries CONFIGURATION and this
    // is not configuration: a refresh would have to write a bank list into the profile's own config
    // file, and a delete has no honest spelling as a settings write. So this half registers one
    // exact Fetch route on the Host's connection service — the route registry the web transport
    // always provides — and the browser half calls it with a document-relative `fetch`, under the
    // same origin and the same session cookie the page itself was served with.
    //
    // Optional, like `settings` and `commands`: a composition without a web transport (a headless
    // run, the CLI) simply has no route, and the page renders its "unavailable" state instead of
    // waiting forever for an answer that cannot come.
    ctx.inject?.(["connection"], (child) => {
      const scope = (child ?? ctx) as ConnectionScope;
      const register = scope.connection?.fetch?.register;
      if (typeof register !== "function") {
        log.debug(HARNESS, "no connection route registry in this composition; the library list is off");
        return;
      }
      scope.effect?.(
        () => {
          // The registry wraps the registration in an effect on the READING context — the same
          // child fiber this run is on — so disposal is already owned. Nothing is returned here
          // because `register`'s own return value is the registry's business, not this plugin's.
          register({
            path: LIBRARY_ROUTE,
            // One path, two meanings: GET lists, POST removes. Both are answered as JSON with a 200
            // for a failure the page should SHOW (an unreachable server) — see bank-admin.ts.
            methods: ["GET", "POST"],
            requestBody: "buffered",
            fetch: (request) => handleLibraryRequest(request, libraryDeps()),
          });
          // One line next to the bind line, for the reason that line exists: "did the page's list
          // get a route at all" is otherwise only answerable from inside a session. Written after
          // the registration, so the line means the route IS there rather than that it was asked
          // for — a registry that refuses the path leaves no such line.
          log.info(HARNESS, "hindsight library route registered", { path: LIBRARY_ROUTE });
        },
        "hindsight: library route"
      );
    });

    // A volatile-only write updates the config references in place, so reading through this same
    // thunk now answers with the saved values; installing it again is what drops the cached
    // workspaces that were built against the old ones. The same event carries the page's one-click
    // setup request, which is a field write like any other.
    ctx.on("loader/volatile-update", () => {
      setRuntimeConfigSource(source);
      publishHostOverrides();
      publishModelChoices();
      refreshDaemonModelEnv();
      const request = pendingSetupRequest(lastRequest, readSettings(config));
      if (request !== undefined) {
        lastRequest = request;
        acceptRequest();
      }
    });
    const settings = readSettings(config);
    // Daemon mode spawns `uvx` by name, so it resolves through PATH — and a GUI-launched app never
    // reads the shell's PATH, which is exactly where uv's installer lands. Done before the runtime
    // binds, because its first daemon preflight reads PATH too.
    const uv = ensureUvOnPath({ configuredDir: settings.uvDir });
    // The local server extracts with a model of its own — always one of dsh's configured models,
    // resolved through the harness facts; there is no hand-typed route into the daemon anymore.
    const daemonModelCount = harnessModelChoices(harnessFactsHere()).length;
    applyHindsight(ctx as never);
    // One line per process, in the plugin log every other Hindsight harness writes. It is the only
    // way to answer "is memory actually on, and where is it pointed" without a session in flight,
    // and it deliberately omits the token.
    log.info("dsh", "memory plugin bound", {
      mode: settings.serverMode ?? DEFAULT_SETTINGS.serverMode,
      enabled: settings.enabled !== false,
      apiUrl: settings.apiUrl?.trim() || undefined,
      uv: uv.added ? `found in ${uv.added}` : uv.alreadyOnPath ? "on PATH" : undefined,
      daemonModels: daemonModelCount || undefined,
    });
  } catch (error) {
    // Fail open, and loudly. A third-party plugin that throws here fails its Loader entry, and on
    // this host that is enough to stop the application from opening at all — a memory feature must
    // never be able to do that. The session simply runs without memory, and the reason is on the
    // plugin log.
    //
    // BOTH sinks, deliberately. `ctx.logger` is the host's console, which on this host goes to the
    // Electron process and is kept in no file — a bind that failed this way was invisible for hours
    // (2026-10-14), while `plugin.log` showed nothing at all because the bind line never ran. The
    // plugin's own log is the one a user can still read afterwards.
    //
    // The logger call is NOT detached: on the Cordis context proxy every property read goes through
    // a getter, so pulling `ctx.logger.error` out as a value loses its receiver and the call
    // throws "this is not a function" — hiding the very reason it wanted to report.
    const line = `hindsight: memory disabled — the plugin failed to bind: ${error instanceof Error ? error.message : String(error)}`;
    log.error(HARNESS, line);
    if (ctx.logger && typeof ctx.logger.error === "function") ctx.logger.error(line);
    else console.error(line);
  }
}

/**
 * The default export, which is what the Loader actually mounts.
 *
 * `unwrapExports` prefers `exports.default` over the module namespace, and it is from THAT object
 * that Cordis reads `Config` (to validate the entry's configuration and to project the settings
 * form). A default without `Config` therefore produces an entry that loads, binds, and reports no
 * schema at all — no settings namespace, no page, and no error anywhere.
 */
export default { name, inject, apply, Config };
