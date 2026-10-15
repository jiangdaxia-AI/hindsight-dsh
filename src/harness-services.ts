/**
 * Reading the harness's own model configuration, so the local server can reuse it.
 *
 * A user who has dsh working already has a provider, an endpoint, a model and a key. Making them
 * type a second key for local memory is the reason the one-click setup exists, so this module
 * answers one question — "what is dsh actually talking to?" — from the services the host already
 * exposes:
 *
 *   `llm.listProviders()`   the routes with an adapter, in registration order
 *   `settings.describe()`   every active entry's live configuration, secrets redacted
 *   `credentials.resolve()` the value behind a reference, for an operation that needs it
 *
 * Everything here is optional and defensive: a composition without these services simply yields
 * `undefined`, and the setup reports that it could not find a model rather than failing to load.
 * The credential VALUE is read here and handed straight to the daemon's environment; it is never
 * returned to the browser, written into the settings document, or logged.
 */
import { type DaemonModel, type HarnessRouteFacts, modelFromHarness, modelIds, providersOf } from "./setup";

/** The slice of the LLM service this needs. */
export interface LlmServiceLike {
  listProviders?(): Array<{ id?: unknown }>;
}

/** The slice of the Settings service this needs. `describe()` is what the browser mirror reads. */
export interface SettingsServiceLike {
  describe?(options?: { redactSecrets?: boolean }): Array<{ ns?: unknown; value?: unknown }>;
  update?(ns: string, patch: Record<string, unknown>, expectedRevision?: number): Promise<void>;
  mutate?(
    ns: string,
    ops: Array<{ op: "set" | "unset"; path: string[]; value?: unknown }>,
    expectedRevision?: number
  ): Promise<void>;
  configure?(presentation: { auto?: boolean }, owner?: unknown): void;
}

/** The slice of the credentials seam this needs. */
export interface CredentialsServiceLike {
  resolve?(ref: string): Promise<{ value?: unknown } | undefined>;
}

/** What a Cordis context offers here: services by name. */
export interface ServiceLookup {
  get?(name: string): unknown;
  settings?: unknown;
  credentials?: unknown;
  llm?: unknown;
}

/** Read one service, however this host spells it. */
export function serviceOf<T>(ctx: ServiceLookup, name: string): T | undefined {
  const fromGet = ctx.get?.(name);
  if (fromGet !== undefined && fromGet !== null) return fromGet as T;
  try {
    const direct = (ctx as Record<string, unknown>)[name];
    return direct === undefined || direct === null ? undefined : (direct as T);
  } catch {
    // On a Cordis context that property read IS a service lookup, and it THROWS for a service the
    // calling fibre did not inject — `cannot get property "llm" without inject`. Every caller here
    // treats these services as optional, so a lookup nobody can answer is exactly that: "this
    // composition does not expose it". Asking must never be fatal; on 2026-10-14 it was, and the
    // plugin bound to nothing (see `harnessFactsHere` in host.ts).
    return undefined;
  }
}

/** The provider/model dsh currently uses, read from its own configuration. */
function activeRoute(namespaces: Array<{ ns: string; value?: Record<string, unknown> }>) {
  for (const row of namespaces) {
    const value = row.value;
    if (!value) continue;
    const provider = typeof value.provider === "string" ? value.provider : undefined;
    const model = typeof value.model === "string" ? value.model : undefined;
    // The entry that names a default model is the one that decides; a provider entry that happens to
    // carry a `provider` string is not.
    if (provider && (row.ns.includes("model") || row.ns.includes("agent"))) return { provider, model };
  }
  return undefined;
}

/**
 * Ask the host what model the local server should use.
 *
 * @param ctx - the plugin's context, or anything that can look services up by name.
 * @returns the model to hand the daemon, or `undefined` when nothing can be discovered.
 */
export function harnessFacts(ctx: ServiceLookup): HarnessRouteFacts {
  const llm = serviceOf<LlmServiceLike>(ctx, "llm");
  const settings = serviceOf<SettingsServiceLike>(ctx, "settings");
  const credentials = serviceOf<CredentialsServiceLike>(ctx, "credentials");
  const routes = (llm?.listProviders?.() ?? [])
    .map((provider) => (typeof provider?.id === "string" ? provider.id : undefined))
    .filter((id): id is string => id !== undefined);
  const rows = settings?.describe?.({ redactSecrets: true }) ?? [];
  const namespaces = rows
    .map((row) => ({
      ns: typeof row?.ns === "string" ? row.ns : "",
      value: (typeof row?.value === "object" && row.value !== null ? row.value : undefined) as
        | Record<string, unknown>
        | undefined,
    }))
    .filter((row) => row.ns !== "");
  return {
    routes,
    ...(activeRoute(namespaces) ? { active: activeRoute(namespaces) } : {}),
    namespaces,
    ...(credentials?.resolve
      ? {
          resolveCredential: async (ref: string) => {
            const hit = await credentials.resolve?.(ref);
            const value = hit?.value;
            return typeof value === "string" && value.length > 0 ? value : undefined;
          },
        }
      : {}),
  };
}

/**
 * Ask the host what model the local server should use.
 *
 *
 * @param ctx - the plugin's context, or anything that can look services up by name.
 * @returns the model to hand the daemon, or `undefined` when nothing can be discovered.
 */
export async function harnessModel(ctx: ServiceLookup): Promise<DaemonModel | undefined> {
  return modelFromHarness(harnessFacts(ctx));
}

/**
 * Every model dsh itself offers, as the settings page's choice list.
 *
 * One entry per advertised model per route, in the host's own order, plus each route's current
 * model when the configuration names one and the route advertises no explicit list. This is the
 * ONLY list the page may offer: the local service runs on a model dsh is configured for, never on
 * a hand-typed provider or key.
 *
 * @param facts - the facts collected from the host's own services.
 * @returns the choices, empty when dsh offers no route.
 */
export function harnessModelChoices(facts: HarnessRouteFacts): Array<{ route: string; model: string }> {
  const out: Array<{ route: string; model: string }> = [];
  const seen = new Set<string>();
  const push = (route: string, model: string) => {
    const key = `${route}::${model}`;
    if (!model || seen.has(key)) return;
    seen.add(key);
    out.push({ route, model });
  };
  for (const route of facts.routes) {
    for (const namespace of facts.namespaces) {
      const entry = providersOf(namespace.value)?.[route];
      if (!entry) continue;
      const ids = modelIds(entry);
      if (ids.length) {
        for (const id of ids) push(route, id);
      } else if (facts.active?.provider === route && facts.active.model) {
        push(route, facts.active.model);
      }
    }
  }
  return out;
}
