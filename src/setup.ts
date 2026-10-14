/**
 * One-click setup: make local memory work, and say plainly whether it does.
 *
 * The page's job is to ask; this module's job is to do the four things that actually have to happen,
 * in the order they can fail:
 *
 *   1. `uv` — the local server is fetched and run through `uvx`. dsh is launched from Finder, so it
 *      never inherits the shell's PATH, which is exactly where uv's installer lands. If uv is
 *      missing entirely, the official installer is run once.
 *   2. a model — the local server extracts facts with a model of its own, and until one is chosen
 *      nothing else can work. There are exactly two sources, because the alternative is a setup that
 *      silently spends some other tool's credential: the model the user picked on the page (one of
 *      dsh's own configured models, resolved through the same harness facts), or **the provider dsh
 *      is already using**. The second is the common case and the point of the button: a user with
 *      dsh working already has an endpoint, a model and a key, and should not have to find a second
 *      key. A hand-typed provider, endpoint or key is deliberately NOT a source anymore.
 *   3. the service — spawned detached, because a cold start pays for a `uvx` download plus model
 *      loads and outlives any page. The child keeps going even if the settings panel is closed.
 *   4. health — `/health` is polled until it answers, so "started" never means "probably fine".
 *
 * Everything is injected: the runner owns the ORDER and the REPORTING, nothing else. That is what
 * lets a test drive every failure — missing uv, missing model, a service that never answers — with
 * no child process, no network, and no clock.
 *
 * The result is one {@link SetupStatus}. It carries no credential: the key goes into the daemon's
 * environment and nowhere else, and the status says only where the model came from.
 */
import { execFile } from "node:child_process";
import { CHOICE_SOURCE_PREFIX, type DshSettings, parseLlmChoice } from "./fields";
import type { SetupStatus, SetupStepState } from "./setup-types";

/** The model the local server will extract facts with, and where it came from. */
export interface DaemonModel {
  /** A Hindsight provider id (`openai`, `anthropic`, `deepseek`, `claude-code`, ...). */
  provider: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  /** Human-readable provenance, shown in the page's success line. */
  source: string;
}

/** Everything the runner touches, injected. */
export interface SetupDeps {
  settings: Partial<DshSettings>;
  env: NodeJS.ProcessEnv;
  publish(status: SetupStatus): void;
  /** Add the directory holding uv to PATH. Returns what it did, exactly like `ensureUvOnPath`. */
  ensureUv(configuredDir?: string): { added?: string; alreadyOnPath: boolean };
  hasUvx(): boolean;
  installUv(): Promise<{ ok: boolean; detail?: string }>;
  /** The provider dsh itself is using, when it can be discovered. */
  resolveHarnessModel(): Promise<DaemonModel | undefined>;
  /** The model the user picked from dsh's own list, resolved the same way. */
  resolveChosenModel?: () => Promise<DaemonModel | undefined>;
  /** Where the local service will answer, derived from the same config the start uses. */
  daemonTarget(): { apiUrl: string; port: number };
  /** Whether the RUNNING service must be restarted to use `model` — its model differs. */
  needsRestart?(model: DaemonModel): boolean;
  /** Write the model into the environment the child inherits, then spawn the detached starter. */
  startDaemon(model: DaemonModel | undefined, opts?: { restart?: boolean }): void;
  healthy(url: string, timeoutMs?: number): Promise<boolean>;
  sleep(ms: number): Promise<void>;
  now(): number;
  /** How long to wait for `/health`. Minutes, not seconds: a cold start downloads the server. */
  waitMs?: number;
  pollMs?: number;
}

/** Five minutes: a first run downloads the server and its local models. */
export const SETUP_WAIT_MS = 300_000;
/** Passed to a single `/health` probe. */
export const SETUP_PROBE_MS = 2_000;

/**
 * The model the user picked on the settings page, resolved against the harness's own facts.
 *
 * The choice is "<route>::<model>" — always one of the entries the page offered, which the host
 * half derives from dsh's own model configuration — so resolving it means finding that route's
 * entry and its credential, exactly like the un-picked default does. There is no free-text path
 * into the daemon's model anymore: nothing but a route dsh itself has configured can be spent.
 *
 * @param settings - the page's values, for the choice itself.
 * @param facts - what the caller collected from `llm`, `settings.describe()` and `credentials`.
 * @returns the model to hand the local server, or undefined when nothing was picked or the pick
 *   names a route that no longer exists.
 */
export async function modelFromChoice(
  settings: Partial<DshSettings>,
  facts: HarnessRouteFacts
): Promise<DaemonModel | undefined> {
  const choice = parseLlmChoice(settings.llmChoice);
  if (!choice) return undefined;
  const resolved = await modelFromHarness({ ...facts, active: { provider: choice.route, model: choice.model } });
  return resolved
    ? { ...resolved, source: `${CHOICE_SOURCE_PREFIX}${settings.llmChoice?.trim()}` }
    : undefined;
}

/** How one resolved model is compared across runs — a provider and a model name. */
function modelKey(model: { provider?: string; model?: string } | undefined): string {
  return [model?.provider, model?.model].filter(Boolean).join("/");
}

/**
 * Whether a RUNNING service must be restarted to use `model`.
 *
 * The daemon takes its model from the environment at startup, and the starter only starts when the
 * port is dead — so a healthy daemon keeps whatever it was launched with. Comparing the model the
 * last run recorded against the one about to be applied is what turns "the page changed the pick"
 * into the one action that can make it real: a stop and start. No record means no contradiction
 * (a daemon this plugin never started is left alone).
 */
export function needsRestartFor(
  applied: { provider?: string; model?: string } | undefined,
  model: { provider?: string; model?: string }
): boolean {
  if (!applied) return false;
  return modelKey(applied) !== modelKey(model);
}

/**
 * A model stated for HINDSIGHT itself, in this process's environment.
 *
 * Only the explicit `HINDSIGHT_API_LLM_PROVIDER` counts. This is the documented way to configure
 * the server's own model, so someone who set it has made a decision about it — and a decision has
 * to beat a guess. What is deliberately NOT read here: the ambient provider keys (`OPENAI_API_KEY`
 * and friends) and the Claude Code CLI. Those are other tools' credentials, and this setup may only
 * use the model the user configured for dsh, or one they picked from dsh's own models on the page.
 */
export function modelFromExplicitEnv(env: NodeJS.ProcessEnv): DaemonModel | undefined {
  const provider = env.HINDSIGHT_API_LLM_PROVIDER?.trim();
  if (!provider) return undefined;
  const apiKey = env.HINDSIGHT_API_LLM_API_KEY?.trim();
  const baseUrl = env.HINDSIGHT_API_LLM_BASE_URL?.trim();
  const model = env.HINDSIGHT_API_LLM_MODEL?.trim();
  return {
    provider,
    ...(baseUrl ? { baseUrl } : {}),
    ...(model ? { model } : {}),
    ...(apiKey ? { apiKey } : {}),
    source: "HINDSIGHT_API_LLM_PROVIDER",
  };
}

/** One provider route as the settings document and the LLM service describe it. */
export interface HarnessRouteFacts {
  /** Route ids the LLM service has an adapter for (`llm.listProviders()`). */
  routes: string[];
  /** The provider and model dsh currently runs, when its own configuration says. */
  active?: { provider?: string; model?: string };
  /** Every active settings namespace and its live value, straight from `settings.describe()`. */
  namespaces: Array<{ ns: string; value?: Record<string, unknown> }>;
  /** Read a credential reference (`ctx.credentials.resolve`). Absent when nothing can resolve it. */
  resolveCredential?(ref: string): Promise<string | undefined>;
}

/** A provider entry inside an adapter's `providers` dictionary. */
interface RouteConfig {
  api?: string;
  baseURL?: string;
  apiKeyEnv?: string;
  models?: unknown;
}

/** The `providers` dictionary of one namespace's value, when it holds one. */
export function providersOf(value: Record<string, unknown> | undefined): Record<string, RouteConfig> | undefined {
  const providers = value?.providers;
  if (typeof providers !== "object" || providers === null || Array.isArray(providers)) return undefined;
  const out: Record<string, RouteConfig> = {};
  for (const [route, entry] of Object.entries(providers as Record<string, unknown>)) {
    if (typeof entry === "object" && entry !== null) out[route] = entry as RouteConfig;
  }
  return Object.keys(out).length ? out : undefined;
}

/** The model ids an adapter advertises for one route. */
export function modelIds(entry: RouteConfig | undefined): string[] {
  if (!Array.isArray(entry?.models)) return [];
  return entry.models
    .map((model) =>
      typeof model === "string"
        ? model
        : typeof model === "object" && model !== null && typeof (model as { id?: unknown }).id === "string"
          ? (model as { id: string }).id
          : undefined
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/**
 * The provider dsh already uses, mapped onto the Hindsight server's own provider vocabulary.
 *
 * This is the path that makes the button worth pressing: a user who has dsh working has a model, an
 * endpoint and a key, and none of that should have to be typed a second time. It reads only
 * CONFIGURATION — the route's `api`, `baseURL` and `apiKeyEnv` — and then asks the credentials seam
 * for the value behind that reference. The key is never returned to the browser and never logged.
 *
 * @param facts - what the caller collected from `llm`, `settings.describe()` and `credentials`.
 * @returns the model to hand the local server, or `undefined` when dsh offers nothing usable.
 */
export async function modelFromHarness(facts: HarnessRouteFacts): Promise<DaemonModel | undefined> {
  const wanted = facts.active?.provider ?? facts.routes[0];
  if (!wanted) return undefined;
  const ordered = [wanted, ...facts.routes.filter((route) => route !== wanted)];
  for (const route of ordered) {
    for (const namespace of facts.namespaces) {
      const entry = providersOf(namespace.value)?.[route];
      if (!entry) continue;
      const ids = modelIds(entry);
      // An explicitly named model wins when the route advertises it; otherwise the route's first
      // advertised model is the best statement of "what dsh uses on this route".
      const model =
        facts.active?.model && ids.includes(facts.active.model)
          ? facts.active.model
          : facts.active?.model ?? ids[0];
      const apiKey =
        entry.apiKeyEnv && facts.resolveCredential
          ? await facts.resolveCredential(entry.apiKeyEnv).catch(() => undefined)
          : undefined;
      // A route with a base URL speaks the OpenAI protocol to that endpoint; one without it is the
      // provider's own service, which the Hindsight provider table already knows by name.
      const provider = routeProvider(route, entry, facts);
      return {
        provider,
        ...(entry.baseURL ? { baseUrl: entry.baseURL } : {}),
        ...(model ? { model } : {}),
        ...(apiKey ? { apiKey } : {}),
        source: `${namespace.ns}/${route}${entry.apiKeyEnv ? ` (${entry.apiKeyEnv})` : ""}`,
      };
    }
  }
  return undefined;
}

/**
 * Map a dsh route onto a Hindsight provider id.
 *
 * A custom endpoint (`baseURL`) is reached through the server's `openai` provider, which is what an
 * OpenAI-compatible gateway is. Without one, the route's own name is offered to the server, which
 * already ships providers named after the big APIs (`deepseek`, `anthropic`, `gemini`, ...) — and
 * failing that, `openai` remains the documented default.
 */
function routeProvider(route: string, entry: RouteConfig, facts: HarnessRouteFacts): string {
  if (entry.baseURL) return "openai";
  const known = ["openai", "anthropic", "gemini", "deepseek", "groq", "ollama", "lmstudio"];
  const named = known.find((provider) => route.includes(provider));
  if (named) return named;
  const fromName = facts.active?.provider;
  return fromName && known.includes(fromName) ? fromName : "openai";
}

/** The result of one step, appended to the status as it completes. */
function step(id: SetupStepState["id"], ok: boolean, detail?: string): SetupStepState {
  return { id, ok, ...(detail ? { detail } : {}) };
}

/**
 * Run the whole setup and report it.
 *
 * Never throws and never rejects: every failure becomes a `failed` status carrying a code the page
 * localizes, so the button can offer a retry instead of an error console.
 *
 * @param deps - the injected steps, clock and reporter.
 * @returns the final status, identical to the last one published.
 */
export async function runSetup(deps: SetupDeps): Promise<SetupStatus> {
  const startedAt = deps.now();
  const waitMs = deps.waitMs ?? SETUP_WAIT_MS;
  const pollMs = deps.pollMs ?? 1_000;
  const steps: SetupStepState[] = [];
  const emit = (status: Omit<SetupStatus, "at" | "steps">): SetupStatus => {
    const full: SetupStatus = { at: deps.now(), steps: [...steps], ...status };
    try {
      deps.publish(full);
    } catch {
      /* reporting is best-effort; a write that fails must not abort the setup */
    }
    return full;
  };
  const fail = (code: SetupStatus["code"], detail: string | undefined, stepId?: SetupStepState["id"]) => {
    if (stepId) steps.push(step(stepId, false, detail));
    return emit({ phase: "failed", code, ...(detail ? { detail } : {}), elapsedMs: deps.now() - startedAt });
  };

  const mode = deps.settings.serverMode ?? "daemon";
  if (mode !== "daemon") {
    // The page offers this button for the local option; anything else is a stale request.
    return fail("not-daemon", mode);
  }

  emit({ phase: "running", step: "uv" });
  try {
    const uv = deps.ensureUv(deps.settings.uvDir);
    if (!deps.hasUvx()) {
      const installed = await deps.installUv();
      if (!installed.ok || !deps.hasUvx()) {
        return fail("uv-missing", installed.detail ?? "uvx is not on PATH", "uv");
      }
      deps.ensureUv(deps.settings.uvDir);
      steps.push(step("uv", true, "installed"));
    } else {
      steps.push(step("uv", true, uv.added ?? (uv.alreadyOnPath ? "on PATH" : undefined)));
    }
  } catch (error) {
    return fail("error", message(error), "uv");
  }

  emit({ phase: "running", step: "model" });
  let model: DaemonModel | undefined;
  try {
    // Only two sources, on purpose: the model the user picked from dsh's own list, and what dsh is
    // configured with. This setup does not go looking for provider keys that belong to other tools,
    // and it no longer accepts a hand-typed provider or key from the page either.
    model = (await deps.resolveChosenModel?.()) ?? modelFromExplicitEnv(deps.env);
    if (!model) model = await deps.resolveHarnessModel();
    if (!model) {
      return fail(
        "model-missing",
        "no model is picked on this page, and dsh has no provider configured to reuse",
        "model"
      );
    }
    steps.push(step("model", true, [model.provider, model.model].filter(Boolean).join("/") + ` — ${model.source}`));
  } catch (error) {
    return fail("error", message(error), "model");
  }

  try {
    // Resolving the target is a step like any other: a config that explodes here is a failure
    // status, not an exception out of a runner that promises never to throw. It is synchronous
    // and instant, so progress waits for it and the page sees the URL with the step it names.
    const target = deps.daemonTarget();
    // A daemon that is already up is left alone UNLESS its model is not the one being applied: the
    // model reaches the daemon through the environment at startup, so a healthy port would
    // otherwise pin the old pick forever while this status — and the page — claimed the new one.
    const restart = deps.needsRestart?.(model) === true;
    emit({ phase: "running", step: "service", service: { url: target.apiUrl } });
    if (!restart && (await deps.healthy(target.apiUrl, SETUP_PROBE_MS))) {
      steps.push(step("service", true, `already running on ${target.apiUrl}`));
    } else {
      deps.startDaemon(model, { restart });
      const deadline = deps.now() + waitMs;
      let up = false;
      while (deps.now() < deadline) {
        await deps.sleep(pollMs);
        if (await deps.healthy(target.apiUrl, SETUP_PROBE_MS)) {
          up = true;
          break;
        }
      }
      if (!up) {
        return fail("unhealthy", `${target.apiUrl}/health did not answer within ${Math.round(waitMs / 1000)}s`, "service");
      }
      steps.push(
        step("service", true, restart ? `restarted on ${target.apiUrl}` : `started on port ${target.port}`)
      );
    }
    return emit({
      phase: "ok",
      code: "ok",
      elapsedMs: deps.now() - startedAt,
      service: {
        url: target.apiUrl,
        provider: model.provider,
        ...(model.model ? { model: model.model } : {}),
        source: model.source,
      },
    });
  } catch (error) {
    return fail("error", message(error), "service");
  }
}

/** A failure's one line, without ever letting a thrown non-Error render as `[object Object]`. */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Install uv with the vendor's own installer.
 *
 * Only reached when `uvx` cannot be found anywhere: on macOS the installer lands in `~/.local/bin`,
 * which the caller re-scans afterwards, so a GUI-launched app finds it without a restart.
 *
 * @param env - the environment to install with, so a test can point it elsewhere.
 * @returns whether uvx answers afterwards, with the installer's last line when it does not.
 */
export function installUv(env: NodeJS.ProcessEnv = process.env): Promise<{ ok: boolean; detail?: string }> {
  const command =
    process.platform === "win32"
      ? ["powershell", ["-NoProfile", "-Command", "irm https://astral.sh/uv/install.ps1 | iex"]]
      : ["sh", ["-c", "curl -LsSf https://astral.sh/uv/install.sh | sh"]];
  return new Promise((resolve) => {
    execFile(
      command[0] as string,
      command[1] as string[],
      { timeout: 180_000, env, windowsHide: true },
      (error, stdout, stderr) => {
        const tail = `${stdout}\n${stderr}`.trim().split("\n").filter(Boolean).slice(-1)[0];
        resolve(error ? { ok: false, detail: tail ?? message(error) } : { ok: true, ...(tail ? { detail: tail } : {}) });
      }
    );
  });
}
