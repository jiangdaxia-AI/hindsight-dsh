/**
 * The one description of what this plugin lets a user configure.
 *
 * Kept free of every runtime import — no Schemastery, no memory engine — because BOTH halves read
 * it: the host half builds its Config schema from these names, and the browser half builds its form
 * from the same names and enum members. A second copy in the client is how a page starts showing a
 * field the host no longer has.
 */

/** The settings namespace, which is also the Loader entry id this package's patch row inserts. */
export const NAMESPACE = "hindsight";

/** How memory reaches a Hindsight API. */
export const SERVER_MODES = ["daemon", "self-hosted", "cloud"] as const;
export type ServerMode = (typeof SERVER_MODES)[number];

/** What the first prompt of a session receives. */
export const AUTO_INJECT_MODES = ["reflect", "pages", "recall", "none"] as const;
export type AutoInjectMode = (typeof AUTO_INJECT_MODES)[number];

/** How detail removed by a context compaction is offered back. */
export const REHYDRATE_MODES = ["off", "handle", "auto"] as const;
export type RehydrateMode = (typeof REHYDRATE_MODES)[number];

/** Plugin log verbosity. */
export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** Every value the settings page can write, as the page and the host schema both see it. */
export interface DshSettings {
  /**
   * Whether the user has ever SAVED this page.
   *
   * The overrides layer outranks `~/.hindsight/coding-agent.json`, so a page that projected its
   * defaults unconditionally would override the file of a user who installed the plugin and never
   * opened the settings. Until this marker is set, `toRuntimeConfig` projects nothing and the file
   * is the single source of truth; the first save adopts the page as the authoritative surface for
   * every field it renders.
   */
  adopted: boolean;
  enabled: boolean;
  serverMode: ServerMode;
  apiUrl: string;
  apiToken: string;
  apiPort: number;
  uvDir: string;
  /**
   * Which of dsh's configured models the local server extracts facts with.
   *
   * The value is "<route>::<model>" — one entry of the list the host half publishes as
   * modelChoices. Blank means "whatever dsh itself is currently using", which is also what the
   * one-click setup resolves when nothing is picked. There is deliberately no way to hand-type a
   * provider, an endpoint or a key here: the local service may only spend a model dsh is already
   * configured with.
   */
  llmChoice: string;
  /**
   * The models dsh currently offers, as JSON ("[{ \"route\": ..., \"model\": ... }]"), written by
   * this plugin's host half and read by its page to populate the choice above. Not a preference.
   */
  modelChoices: string;
  bankId: string;
  bankIdTemplate: string;
  /**
   * A nonce the page writes to ask the host half to prepare the local service.
   *
   * It rides the settings document because the request and its answer ARE configuration — the run
   * resolves the very fields around them, and an unchanged value is not a new request, which is what
   * keeps the nonce from surviving as a preference. The host clears it once the run is accepted.
   *
   * This is NOT the only channel a client plugin has into its own host half, and it is not the right
   * one for everything: the settings page's library list and its delete travel an exact Fetch route
   * on the Host's connection service instead, because a list is not configuration and a refresh must
   * not rewrite the profile's config file. See `src/bank-admin.ts`.
   */
  setupRequest: string;
  /** The host's answer to {@link DshSettings.setupRequest}: one JSON `SetupStatus`, or "". */
  setupStatus: string;
  autoInject: AutoInjectMode;
  retainSessions: boolean;
  compactionAware: boolean;
  rehydrateMode: RehydrateMode;
  codeFactEnabled: boolean;
  autoSeed: boolean;
  optInOnly: boolean;
  logLevel: LogLevel;
}

/**
 * The defaults, which are ALSO the values written into the profile by a fresh install.
 *
 * `serverMode: "daemon"` is the one deliberate departure from the shared config file's default:
 * this plugin is meant to be installed and used without an account, so it starts by talking to the
 * local Hindsight daemon (which needs `uv`/`uvx` on PATH) rather than to Hindsight Cloud, which
 * cannot answer a single request without a token.
 */
export const DEFAULT_SETTINGS: DshSettings = {
  adopted: false,
  enabled: true,
  serverMode: "daemon",
  apiUrl: "",
  apiToken: "",
  apiPort: 9077,
  uvDir: "",
  llmChoice: "",
  modelChoices: "",
  bankId: "",
  bankIdTemplate: "coding-agent::{gitProject}",
  setupRequest: "",
  setupStatus: "",
  autoInject: "reflect",
  retainSessions: true,
  compactionAware: true,
  rehydrateMode: "handle",
  codeFactEnabled: false,
  autoSeed: true,
  optInOnly: false,
  logLevel: "info",
};

/** Fields the page reads and writes as free text. */
export const TEXT_FIELDS = ["apiUrl", "uvDir", "bankId", "bankIdTemplate"] as const;
/** Fields the page reads and writes as numbers. */
export const NUMBER_FIELDS = ["apiPort"] as const;
/** Fields written through a select control, with the members they offer. */
export const SELECT_FIELDS = {
  serverMode: SERVER_MODES,
  autoInject: AUTO_INJECT_MODES,
  rehydrateMode: REHYDRATE_MODES,
  logLevel: LOG_LEVELS,
} as const;
/** Fields written through a switch. */
export const SWITCH_FIELDS = [
  "enabled",
  "retainSessions",
  "compactionAware",
  "codeFactEnabled",
  "autoSeed",
  "optInOnly",
] as const;
/** The Hindsight bearer token, written through a secret control. */
export const SECRET_FIELD = "apiToken";

/** Serialize one offered model the way llmChoice spells it. */
export function llmChoiceKey(choice: { route: string; model?: string }): string {
  return `${choice.route}::${choice.model ?? ""}`;
}

/**
 * The provenance label a resolved model carries when it came from the page's own pick.
 *
 * Shared because two halves read it: the host builds the label when it resolves a choice, and the
 * page parses it back out of the last status to tell whether the RUNNING service is still on the
 * model this page is showing.
 */
export const CHOICE_SOURCE_PREFIX = "choice: ";

/** The `route::model` a status's `source` says was applied, or undefined when the model came from
 *  somewhere else (dsh's current model, an explicit environment). */
export function appliedChoice(source: string | undefined): string | undefined {
  const raw = source?.trim();
  if (!raw?.startsWith(CHOICE_SOURCE_PREFIX)) return undefined;
  const value = raw.slice(CHOICE_SOURCE_PREFIX.length).trim();
  return value === "" ? undefined : value;
}

/** Parse an llmChoice value; undefined for blank or malformed values. */
export function parseLlmChoice(value: string | undefined): { route: string; model?: string } | undefined {
  const raw = value?.trim();
  if (!raw) return undefined;
  const split = raw.indexOf("::");
  if (split <= 0) return undefined;
  const route = raw.slice(0, split);
  const model = raw.slice(split + 2);
  return { route, ...(model ? { model } : {}) };
}
