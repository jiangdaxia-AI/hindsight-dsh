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
 */
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
