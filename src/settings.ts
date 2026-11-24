/**
 * The host half's configuration surface: one Schemastery schema, and the projection of its values
 * onto the shared memory runtime's own config shape.
 *
 * WHY THIS EXISTS. The packaged plugin configures itself from `~/.hindsight/coding-agent.json`, the
 * file every other Hindsight harness shares. A plugin the user installs inside dsh should not require
 * them to find and hand-edit that file, so this package declares a Config schema instead: the Loader
 * validates it, the Settings service exposes its `.volatile()` fields, and the browser half renders
 * them. `loadConfig`'s `overrides` layer then makes the saved values authoritative for exactly the
 * fields the page names, with the file still supplying everything it does not.
 *
 * EVERY field is `.volatile()`. That is what makes a settings write land in the running fiber's
 * config references instead of remounting the plugin — a remount would tear down live sessions'
 * memory cores, and `host.ts` turns the volatile update into a cache drop instead, which is the
 * cheap, correct reaction to "the endpoint moved".
 */
import z from "@deepseek-ai/schemastery";
import type { RawConfig } from "../vendor/coding-agents/src/core/config";
import {
  AUTO_INJECT_MODES,
  DEFAULT_SETTINGS,
  type DshSettings,
  LOG_LEVELS,
  REHYDRATE_MODES,
  SERVER_MODES,
} from "./fields";

/** `z.union([z.const(a), z.const(b), ...])` — Schemastery's spelling of a closed string enum. */
function enumOf<T extends string>(members: readonly T[]) {
  return z.union(members.map((member) => z.const(member)));
}

const Config = z.object({
  adopted: z
    .boolean()
    .default(DEFAULT_SETTINGS.adopted)
    .volatile()
    .description(
      "Whether the user has ever saved this page. Until then the shared config file stays the single source of truth: the page's defaults must not override it."
    ),
  enabled: z
    .boolean()
    .default(DEFAULT_SETTINGS.enabled)
    .volatile()
    .description(
      "Memory on or off for this dsh process. Off leaves every session unmemoried and registers no hindsight_* tools."
    ),
  serverMode: enumOf(SERVER_MODES)
    .default(DEFAULT_SETTINGS.serverMode)
    .volatile()
    .description(
      "daemon: a local Hindsight this plugin starts on demand (needs uv/uvx on PATH). self-hosted: a server you run — set the URL. cloud: Hindsight Cloud — set a token."
    ),
  apiUrl: z
    .string()
    .default(DEFAULT_SETTINGS.apiUrl)
    .volatile()
    .description("Hindsight API base URL. Ignored in daemon mode. Empty uses the mode's default."),
  apiToken: z
    .string()
    .role("secret")
    .default(DEFAULT_SETTINGS.apiToken)
    .volatile()
    .description("Bearer token, when the server wants one. Stored in this profile's config, and never sent back to a browser."),
  apiPort: z
    .number()
    .step(1)
    .min(1)
    .default(DEFAULT_SETTINGS.apiPort)
    .volatile()
    .description("Daemon mode: the port the local daemon listens on (9077 by default; a healthy server there is adopted)."),
  uvDir: z
    .string()
    .default(DEFAULT_SETTINGS.uvDir)
    .volatile()
    .description(
      "Directory holding uv/uvx, when they are not on dsh's PATH. Blank searches the standard install locations (~/.local/bin, ~/.cargo/bin)."
    ),
  llmChoice: z
    .string()
    .default(DEFAULT_SETTINGS.llmChoice)
    .volatile()
    .description(
      'Daemon mode: which of dsh\'s configured models the local server extracts facts with, as "<route>::<model>". Blank follows whatever dsh itself is using.'
    ),
  modelChoices: z
    .string()
    .default(DEFAULT_SETTINGS.modelChoices)
    .volatile()
    .description(
      "The models dsh currently offers, as JSON. Written by this plugin's host half, read by its page. Not a user preference."
    ),
  bankId: z
    .string()
    .default(DEFAULT_SETTINGS.bankId)
    .volatile()
    .description("One shared bank for every repository. Empty = one bank per repository, derived from the session's workspace."),
  bankIdTemplate: z
    .string()
    .default(DEFAULT_SETTINGS.bankIdTemplate)
    .volatile()
    .description(
      "Per-repository bank name format. Placeholders: {gitProject} {project} {harness} {channel} {user}."
    ),
  setupRequest: z
    .string()
    .default(DEFAULT_SETTINGS.setupRequest)
    .volatile()
    .description(
      "Set by the settings page's one-click setup to ask this plugin to prepare the local service. Not a user preference; cleared once the request is accepted."
    ),
  setupStatus: z
    .string()
    .default(DEFAULT_SETTINGS.setupStatus)
    .volatile()
    .description(
      "The one-click setup's last result, as JSON: phase, steps, the service it started, and the reason it failed. Written by this plugin, read by its page."
    ),
  autoInject: enumOf(AUTO_INJECT_MODES)
    .default(DEFAULT_SETTINGS.autoInject)
    .volatile()
    .description("What the first prompt of a session receives: a reflect synthesis, knowledge pages, raw recall, or nothing."),
  retainSessions: z
    .boolean()
    .default(DEFAULT_SETTINGS.retainSessions)
    .volatile()
    .description("Write each completed exchange back into the bank. Off keeps recall, seeding and the tools working."),
  compactionAware: z
    .boolean()
    .default(DEFAULT_SETTINGS.compactionAware)
    .volatile()
    .description("Watch context compaction and keep what it removed recoverable, in this session and in the bank."),
  rehydrateMode: enumOf(REHYDRATE_MODES)
    .default(DEFAULT_SETTINGS.rehydrateMode)
    .volatile()
    .description("How removed detail is offered back: nothing, a short pointer naming the span, or the recovered text itself."),
  codeFactEnabled: z
    .boolean()
    .default(DEFAULT_SETTINGS.codeFactEnabled)
    .volatile()
    .description("Retain one code-grounded fact per turn that changed files, read from the working tree rather than the conversation."),
  autoSeed: z
    .boolean()
    .default(DEFAULT_SETTINGS.autoSeed)
    .volatile()
    .description("Seed a cold repository's bank from its git history when a session starts."),
  optInOnly: z
    .boolean()
    .default(DEFAULT_SETTINGS.optInOnly)
    .volatile()
    .description("Remember only repositories this plugin's config file opted in. Unknown directories stay inert."),
  logLevel: enumOf(LOG_LEVELS)
    .default(DEFAULT_SETTINGS.logLevel)
    .volatile()
    .description("Plugin log verbosity."),
});

export { Config };

/**
 * Project the page's values onto the shared runtime's config.
 *
 * GATED BY `adopted`. The overrides layer outranks the shared config file, and a volatile field
 * reads as its DEFAULT until the user saves — indistinguishable, from here, from a deliberate
 * choice of that same default. So before the first save the page projects NOTHING: a user who
 * configured `~/.hindsight/coding-agent.json` by hand and never opened this page keeps exactly
 * what their file says. The first save sets `adopted: true` and the page becomes authoritative
 * for the fields it renders.
 *
 * Within the adopted layer, only a field the settings object actually carries is projected, and a
 * text field left empty is omitted rather than sent as `""`, because `mergeRaw` overwrites with
 * whatever the layer holds: writing an empty `apiUrl` would erase a URL from the user's own
 * config file, and writing an empty `bankId` would have to mean "dynamic" twice over.
 *
 * @param settings - the host's resolved Config, as the Loader validated it.
 * @returns the layer `loadConfig` applies above the file and the environment.
 */
export function toRuntimeConfig(settings: Partial<DshSettings> | undefined): RawConfig {
  const value = { ...DEFAULT_SETTINGS, ...(settings ?? {}) };
  const raw: RawConfig = {};
  if (value.adopted !== true) return raw;
  raw.disabled = !value.enabled;
  raw.serverMode = value.serverMode;
  raw.apiPort = value.apiPort;
  raw.bankIdTemplate = value.bankIdTemplate;
  raw.autoInject = value.autoInject;
  raw.retainSessions = value.retainSessions;
  raw.compactionAware = value.compactionAware;
  raw.rehydrateMode = value.rehydrateMode;
  raw.codeFactEnabled = value.codeFactEnabled;
  raw.autoSeed = value.autoSeed;
  raw.optInOnly = value.optInOnly;
  raw.logLevel = value.logLevel;
  const url = value.apiUrl?.trim();
  if (url) raw.apiUrl = url;
  const token = value.apiToken?.trim();
  if (token) raw.apiToken = token;
  const bank = value.bankId?.trim();
  if (bank) raw.bankId = bank;
  return raw;
}
