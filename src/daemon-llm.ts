/**
 * The local daemon's own model.
 *
 * Daemon mode starts a Hindsight server on this machine, and that server does the fact extraction —
 * so it needs a model of its own. It cannot borrow dsh's model *call*: the server wants a provider
 * id, an endpoint and a key of its own shape. Those four values come from ONE place now: the model
 * dsh is already configured with, whether that is the one the user picked on the settings page
 * (from the list of dsh's own models) or the one dsh is currently using. A hand-typed provider,
 * endpoint or key has no route into the daemon's environment anymore — a local memory service may
 * only spend a model the harness itself is configured to spend.
 *
 * WHO CALLS THIS. The one-click setup resolves the model (`src/setup.ts` + `harness-services.ts`),
 * and applies it through here before spawning the starter. The resolution goes through the
 * credentials seam (`credentials.resolve(ref)`), which exists for exactly this: an operation that
 * needs the value. The key is read on the host, handed to a local child process's environment, and
 * never sent to a browser, written into the settings document, put in a status, or logged.
 *
 * PRECEDENCE. The runtime forwards every `HINDSIGHT_API_*` from the environment to the daemon, so a
 * model resolved here is applied only where the environment does not already speak.
 *
 * PERSISTENCE. `applyDaemonLlmEnv` alone reached only daemons THIS process spawned: the values live
 * in the plugin's own environment, and the starter persists exactly those to the profile's `.env`
 * (`profile create --merge --env`, via the runtime's `daemonEnv`). A daemon restarted by any other
 * path — a hook-triggered spawn before a choice was installed, the plugin reloading, or a manual
 * `hindsight-embed daemon start` — re-read the profile file and came back on a STALE model, which
 * is why a healthy port could quietly be spending a model the page stopped offering (2026-10-15).
 * `installDaemonLlmEnv` is the durable answer: it keeps the plugin's own environment in step with
 * the resolved choice on every configuration refresh, so whichever process starts the daemon —
 * this one, or a later one reading the profile — resolves the same model.
 */
import { execFile } from "node:child_process";
import type { DaemonModel } from "./setup";

/** Field → environment variable. The names are the server's own; it reads them at startup. */
export const DAEMON_LLM_ENV = {
  provider: "HINDSIGHT_API_LLM_PROVIDER",
  baseUrl: "HINDSIGHT_API_LLM_BASE_URL",
  model: "HINDSIGHT_API_LLM_MODEL",
  apiKey: "HINDSIGHT_API_LLM_API_KEY",
} as const satisfies Record<"provider" | "baseUrl" | "model" | "apiKey", string>;

/**
 * Write the resolved model into the environment the daemon will inherit.
 *
 * @param model - the model the local server should use, as the setup resolved it.
 * @param env - the environment to write into; the process's own by default.
 * @returns the variables actually written, for the one log line that explains the daemon.
 */
export function applyDaemonLlmEnv(
  model: DaemonModel | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  const written: Record<string, string> = {};
  if (!model) return written;
  const values: Partial<Record<keyof typeof DAEMON_LLM_ENV, string>> = {
    provider: model.provider,
    baseUrl: model.baseUrl,
    model: model.model,
    apiKey: model.apiKey,
  };
  for (const [field, name] of Object.entries(DAEMON_LLM_ENV) as Array<[keyof typeof DAEMON_LLM_ENV, string]>) {
    const value = values[field]?.trim();
    if (!value) continue;
    env[name] = value;
    written[name] = name.endsWith("_API_KEY") ? "set" : value;
  }
  return written;
}

/**
 * What a previous install put in each variable, so a later one can put the environment back.
 *
 * `undefined` means "was absent before we touched it"; a string means the user (or the host) had
 * exported that value, and it must come back rather than disappear when the choice that replaced
 * it goes away. Module state, not persisted: it lives exactly as long as the process whose
 * environment it describes.
 */
const installed = new Map<string, string | undefined>();

/**
 * Install the resolved model as this process's daemon model, undoing any earlier install first.
 *
 * The difference from `applyDaemonLlmEnv` is the undo. The setup's own write is a one-shot into an
 * environment it owns for the moment; this one runs on every configuration refresh, against an
 * environment the USER may also have spoken in. Re-installing without restoring would leave a
 * previous choice's values in place whenever the new resolution carries none of a field — and
 * worse, a choice that was CLEARED would leave the old model standing, which is precisely the
 * drift this exists to remove. Restoring tracked values first means the environment ends up
 * holding exactly what the new resolution says, over a floor of whatever the user exported.
 *
 * A `model` of undefined is a valid answer, not a no-op: it removes what this plugin last put
 * there, so a cleared choice lets the daemon fall back to the profile's own configuration rather
 * than pinning the retired pick forever.
 *
 * @param model - the model to install, or undefined to remove the one previously installed.
 * @param env - the environment to write into; the process's own by default.
 * @returns the variables actually written, for the one log line that explains the daemon.
 */
export function installDaemonLlmEnv(
  model: DaemonModel | undefined,
  env: NodeJS.ProcessEnv = process.env
): Record<string, string> {
  // Give back what the last install borrowed. Untouched variables (the user's own exports, or a
  // value the setup wrote) are not tracked and are therefore not the plugin's to remove.
  for (const [name, previous] of installed) {
    if (previous === undefined) delete env[name];
    else env[name] = previous;
  }
  installed.clear();
  if (!model) return {};
  // Snapshot before the write: what each variable held BEFORE this install is what the next
  // restore must put back, and capturing after would just re-record our own values.
  const before = new Map<string, string | undefined>(
    Object.values(DAEMON_LLM_ENV).map((name) => [name, env[name]])
  );
  const written = applyDaemonLlmEnv(model, env);
  for (const name of Object.keys(written)) installed.set(name, before.get(name));
  return written;
}

/**
 * Process-level settings a daemon spawned from here needs, independent of any model choice.
 *
 * THE PROXY MIRROR — why `NO_PROXY` is never written alone. The daemon's HTTP stack resolves its
 * proxy the way Python does: `urllib.request.getproxies()` reads the ENVIRONMENT first and the
 * operating system's proxy settings only as a fallback — and the moment any `*_proxy` variable
 * exists in the environment, the system configuration is ignored entirely. Writing `NO_PROXY`
 * alone therefore does not "exempt the loopback"; it switches the whole daemon from the system
 * proxy to direct connections. On this machine that is measurable death: the system proxy (an
 * xray on 127.0.0.1:10808) is the only route that reaches `huggingface.co`, so a daemon started
 * with a bare `NO_PROXY` spent its whole init budget on 60s HEAD timeouts against a blocked
 * network (2026-10-15) — worse than the thing the exemption was meant to fix.
 *
 * The fix is to write the pair: mirror the system proxy into `HTTP_PROXY`/`HTTPS_PROXY` first
 * (so non-loopback traffic keeps the route it always had), THEN exempt the loopback with
 * `NO_PROXY`. What that buys is the original bug: the daemon's LLM calls to a local gateway on
 * `127.0.0.1` were routed to the system proxy too, and a proxy that is down took the memory
 * service with it — reflect reported `Connection error.` (Errno 61) while the same URL answered
 * from a shell. Both spellings of each variable are set because resolution differs between them.
 *
 * `HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT` — the embed's `daemon start` waits this many seconds
 * for the server to answer health. A cold `uvx` cache installs the whole API environment on first
 * run, which alone has outlived the default 180s (diag: `daemon_start_failed`, "Installed 210
 * packages" then a timeout, while the same start succeeded in 40s once the cache was warm). A
 * budget that survives a cold cache is the difference between "memory was slow once" and "memory
 * is off until the user restarts something".
 */
export const DAEMON_PROCESS_ENV = {
  httpProxy: "HTTP_PROXY",
  httpsProxy: "HTTPS_PROXY",
  httpProxyLower: "http_proxy",
  httpsProxyLower: "https_proxy",
  noProxy: "NO_PROXY",
  noProxyLower: "no_proxy",
  startupTimeout: "HINDSIGHT_EMBED_DAEMON_STARTUP_TIMEOUT",
} as const;

/** What `ensureDaemonProcessEnv` says it did, for the bind's one log line. */
export interface DaemonProcessEnvWritten {
  /** The system proxy mirrored into the environment, if one had to be mirrored. */
  mirroredProxy?: string;
  /** Set when the loopback proxy exemption was written. */
  noProxy: true;
  /** The startup budget the daemon will wait within. */
  startupTimeoutSeconds: string;
}

/** One system-proxy fact as macOS reports it: enabled, and where it listens. */
interface SystemProxy {
  http?: string;
  https?: string;
}

/**
 * Read the OS proxy configuration, the source Python would otherwise fall back to.
 *
 * Only macOS has a stable, spawnable query for this (`scutil --proxy`); on any other platform the
 * honest answer is "unknown", which leaves the environment untouched rather than guessing. The
 * exec happens once per configuration refresh, not per request, and a failure is the same
 * "unknown" — a proxy configuration this cannot read is one this will not override.
 */
export function readSystemProxy(
  platform: NodeJS.Platform = process.platform,
  execFile: (cmd: string, args: string[]) => Promise<{ stdout: string }> = defaultExecFile
): Promise<SystemProxy> {
  if (platform !== "darwin") return Promise.resolve({});
  return execFile("scutil", ["--proxy"]).then(
    ({ stdout }) => {
      const out: SystemProxy = {};
      const value = (key: string): string | undefined => {
        const match = stdout.match(new RegExp(`${key}\\s*:\\s*(\\S+)`));
        return match?.[1];
      };
      const http = value("HTTPEnable") === "1" ? joinHost(value("HTTPProxy"), value("HTTPPort")) : undefined;
      const https = value("HTTPSEnable") === "1" ? joinHost(value("HTTPSProxy"), value("HTTPSPort")) : undefined;
      if (http) out.http = `http://${http}`;
      if (https) out.https = `http://${https}`;
      return out;
    },
    () => ({})
  );
}

/** `host:port`, or undefined when either half is missing. */
function joinHost(host: string | undefined, port: string | undefined): string | undefined {
  return host && port ? `${host}:${port}` : undefined;
}

/** The exec `readSystemProxy` uses by default; wrapped so a test can stub it without spawning. */
function defaultExecFile(cmd: string, args: string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: 2_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve({ stdout: String(stdout) });
    });
  });
}

/**
 * Make sure daemons spawned from this process keep their proxy route and can reach a loopback
 * gateway, and outlive a cold start.
 *
 * Async because reading the system proxy is. Idempotent, and deliberately silent about anything
 * the environment already says: a user who exported their own proxy variables has made a
 * decision, and this only fills silence.
 *
 * @param env - the environment to write into; the process's own by default.
 * @returns what was written, or undefined when the environment already spoke for itself.
 */
export async function ensureDaemonProcessEnv(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  exec: (cmd: string, args: string[]) => Promise<{ stdout: string }> = defaultExecFile
): Promise<DaemonProcessEnvWritten | undefined> {
  const loopback = "127.0.0.1,localhost";
  const write = (name: string, value: string): void => {
    if (env[name] === undefined) env[name] = value;
  };
  const append = (name: string, suffix: string): boolean => {
    const current = env[name];
    if (current === undefined) {
      env[name] = suffix;
      return true;
    }
    if (current.split(",").some((entry) => entry.trim() === "127.0.0.1")) return false;
    env[name] = `${current},${suffix}`;
    return true;
  };

  // The user's own exports are the floor: this never rewrites a proxy the environment names.
  const userSpoke =
    env[DAEMON_PROCESS_ENV.httpProxy] !== undefined ||
    env[DAEMON_PROCESS_ENV.httpsProxy] !== undefined ||
    env[DAEMON_PROCESS_ENV.httpProxyLower] !== undefined ||
    env[DAEMON_PROCESS_ENV.httpsProxyLower] !== undefined;

  let mirroredProxy: string | undefined;
  let wroteProxy = false;
  if (!userSpoke) {
    const system = await readSystemProxy(platform, exec);
    // The pair matters more than either half (see the module comment): without the mirror, the
    // exemption below would switch the daemon's whole traffic to direct connections.
    if (system.http) {
      write(DAEMON_PROCESS_ENV.httpProxy, system.http);
      write(DAEMON_PROCESS_ENV.httpProxyLower, system.http);
      wroteProxy = true;
    }
    if (system.https) {
      write(DAEMON_PROCESS_ENV.httpsProxy, system.https);
      write(DAEMON_PROCESS_ENV.httpsProxyLower, system.https);
      wroteProxy = true;
    }
    mirroredProxy = wroteProxy ? system.https ?? system.http : undefined;
  }

  // Both spellings, always: proxy resolution differs between them, and a short-circuit would
  // leave the one this daemon's stack happens to read without its exemption.
  const upperNoProxy = append(DAEMON_PROCESS_ENV.noProxy, loopback);
  const lowerNoProxy = append(DAEMON_PROCESS_ENV.noProxyLower, loopback);
  const wroteNoProxy = upperNoProxy || lowerNoProxy;

  const wroteTimeout = env[DAEMON_PROCESS_ENV.startupTimeout] === undefined;
  if (wroteTimeout) env[DAEMON_PROCESS_ENV.startupTimeout] = "300";

  const spokeEverything = userSpoke && !wroteNoProxy && !wroteTimeout;
  return spokeEverything
    ? undefined
    : { ...(mirroredProxy ? { mirroredProxy } : {}), noProxy: true, startupTimeoutSeconds: "300" };
}

/**
 * Forget every install `installDaemonLlmEnv` has tracked. Tests only: the map describes one
 * process's environment, and a test that swaps in a fresh one needs the bookkeeping to start over
 * with it.
 */
export function resetDaemonLlmInstallForTest(): void {
  installed.clear();
}
