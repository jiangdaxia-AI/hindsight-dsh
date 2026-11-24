/**
 * Shared runtime for HOOK-based harnesses (Claude Code, Codex, Cursor CLI, ...).
 *
 * The ONE runtime path:
 *   - AUTO-INJECT once per session, on the first prompt, from the source `cfg.autoInject` names:
 *     "reflect" (default) is an agentic synthesis over the bank returning the root-cause decision
 *     with exact values; "pages" is a knowledge-page search and "recall" a raw memory recall, both
 *     retrieval-only and far cheaper; "none" injects nothing and leaves it to the tools. Cached
 *     per session, injected on the turn it ran. A failed or empty attempt is retried on a later
 *     prompt within a small budget. ALL of that policy lives in `core/auto-inject.ts`, which this
 *     file asks one question: what is this step's memory?
 *   - KNOWLEDGE PAGES every turn: the page set is fetched on a cadence and matched LOCALLY against
 *     the prompt (section-level lexical scoring — no server/LLM call); the top sections are
 *     injected with provenance. Fast like recall, organized like reflect.
 *   - The tool-guide/page-roster block re-injects on the same cadence.
 *
 * Every outcome is recorded in the diagnostics file — a memory-less session can't masquerade as a
 * memory session. A failure never breaks the agent.
 *
 * A STEP, not a turn. `buildStepOutput` is called for every step of a session, and a step with no
 * prompt (a tool continuation) is not a turn: it does not advance the turn counter or the roster
 * cadence, and its only memory work is collecting a synthesis that finished after the step that
 * asked for it stopped waiting. That delivery channel is why the parameter is optional at all.
 *
 * A harness plugs in with a HookSpec: its name, how to read (prompt, cwd, sessionId) from its
 * stdin event, and how to wrap injected context in its native output schema. The pure logic lives
 * in `buildStepOutput` (client + cache file in, injection string out) so it's unit-testable
 * without stdin/stdout; `runHook` is thin plumbing around it, with a `makeClient` seam for tests.
 */
import { existsSync } from "node:fs";
import { AutoInject, type AutoInjectClient } from "./auto-inject";
import { deriveBankIdOrSkip } from "./bank";
import type { Config } from "./config";
import { applyBankConfig, loadConfig } from "./config";
import { diag, diagFilePath, readHookEvent } from "./diag";
import { describeError, log, setLogLevel } from "./log";
import { startBackgroundSeed } from "./seed";
import type { ClientOpts } from "./hindsight";
import { HindsightClient } from "./hindsight";
import { brandWord } from "./brand";
import { buildSystemInjection } from "./inject";
import type { PageRef } from "./knowledge-injection";
import { buildRosterRefresh, parsePageList } from "./knowledge-injection";
import {
  readSessionCache,
  sessionCacheFile,
  sessionRootDir,
  stashPendingContext,
  takePendingContext,
  writeSessionCache,
  type SessionCache,
} from "./session-cache";
import { appendJournalTurn, journalPath } from "./turn-journal";

export interface HookEventFields {
  prompt?: string;
  cwd?: string;
  sessionId?: string;
}

export interface HookSpec {
  /** Harness name — config `harnesses.<name>` section, {harness} template field, diag records. */
  harness: string;
  /** Read the fields out of the harness's stdin event (shapes differ per harness). */
  parse(event: Record<string, unknown>): HookEventFields;
  /** Optional event gate, evaluated before config loading: false makes the hook a silent no-op. */
  accept?(event: Record<string, unknown>): boolean;
  /** Some hosts execute hook commands from their global config directory. Those hosts must provide
   * a workspace path in the event; falling back to process.cwd() would create a bank for config. */
  requireCwd?: boolean;
  /** Record this prompt in the session's own turn journal (core/turn-journal.ts). Set ONLY by the
   *  harnesses whose host keeps no durable transcript, because for them the journal IS the
   *  transcript their Stop hook retains — see the ZCode and TraeCode entries in
   *  harness/hook-lifecycle.ts. */
  journalPrompt?: boolean;
  /** Wrap injected context (and an optional user-facing notice) in the harness's native
   *  hook-output schema. Harnesses whose schema has no user-visible channel ignore `notice`. */
  emit(context: string, notice?: string, event?: Record<string, unknown>): unknown;
  /** For a host that only hands a TOOL hook's context to the model (Grok Build): the
   *  turn's context is stashed for the session instead of emitted, and the next event this
   *  accepts (a tool hook routed to the same entry) delivers it once through `emit`. */
  toolHook?: {
    accept(event: Record<string, unknown>): boolean;
    emit(context: string): unknown;
  };
}

/** The client `buildStepOutput` needs: the injection client plus this harness family's page list.
 *  `HindsightClient` satisfies it structurally. */
interface HookClient extends AutoInjectClient {
  /** The page roster, under the caller's deadline — see the call site for why it has one. */
  listPages(opts?: { timeoutMs?: number }): Promise<unknown>;
}

export interface HookOutput {
  /** The model-facing injection block, or undefined when there's nothing to inject. */
  context?: string;
  /** User-facing line(s) — set only on the turn a source actually answered, or failed. */
  notice?: string;
  /** This session's knowledge-page roster, from the shared per-session cache. The SINGLE source
   *  of truth for every page-derived block in a turn: the persistent-plugin runtime rebuilds its
   *  SessionStart preamble from this too, so a turn can no longer be told both "no pages yet" and
   *  a list of pages in the same context. Empty also signals a bank the engine never built. */
  pages: PageRef[];
}

/**
 * Pure step logic: the automatic injection (delegated to `core/auto-inject.ts`) plus the
 * knowledge-page roster on its cadence. Returns the injection and a per-step user-facing notice.
 *
 * `prompt === undefined` marks a non-turn step — a tool continuation. It collects a late synthesis
 * and nothing else: no turn is counted, no roster is refreshed, no source is started.
 */
export async function buildStepOutput(args: {
  harness: string;
  sessionId: string;
  prompt: string | undefined;
  cfg: Config;
  client: HookClient;
  synthesis: AutoInject;
  cacheFile: string;
}): Promise<HookOutput> {
  const { harness, sessionId, prompt, cfg, client, synthesis, cacheFile } = args;
  const isTurn = prompt !== undefined;

  const cached = readSessionCache(cacheFile);
  const turns = isTurn ? (cached.turns ?? 0) + 1 : (cached.turns ?? 0);

  // ── auto-inject: the session's once-only memory, on whatever step it is ready for ──
  // `cfg.autoInject` picks the source and `core/auto-inject.ts` owns every rule around it: the
  // cold-bank deferral, the per-step wait, the retrieval fallback, the retry budget, and delivery
  // of an answer that outlived its step's wait. The goal travels as the STEP's, once.
  const delivery = await synthesis.forStep(
    { harness, sessionId, cfg, client, cacheFile },
    prompt
  );

  // ── knowledge-page roster (ids + titles only): refreshed on the cadence ────────
  const cadence = cfg.pageRefreshEveryTurns;
  const stale =
    isTurn && (!cached.pages || (cadence > 0 && turns - cached.pages.atTurn >= cadence));
  let pages = cached.pages?.list ?? [];
  if (stale) {
    const t0 = Date.now();
    try {
      // The roster shares the injection budget, not the client's generic request cap: this runs on
      // the AWAITED pre-step, and a roster is never the turn's memory — the memory block above is.
      // So a server that stalls this endpoint costs the turn `injectTimeoutMs`, not the 15s a
      // request nobody is waiting on would get.
      pages = parsePageList(await client.listPages({ timeoutMs: cfg.injectTimeoutMs }));
      diag(harness, "pages_ok", { ms: Date.now() - t0, count: pages.length });
    } catch (e) {
      diag(
        harness,
        client.knowledgePagesSupported === false ? "knowledge_pages_unavailable" : "pages_failed",
        {
          ms: Date.now() - t0,
          error: describeError(e),
        }
      );
    }
  }

  // Re-read before writing: the synthesis records `reflectAnswer`/`reflectAttempts` in this same
  // file, and it may have done so while the roster fetch above was in flight. Both writes are
  // synchronous read-modify-write pairs, so neither can observe a half-written record.
  //
  // Only a TURN writes: `turns` and the roster are the only fields this builder owns, and a tool
  // continuation changes neither — `agent/pre-step` is awaited, so a pointless write+rename per tool
  // call is a per-step cost for nothing. (The synthesis's own record is written where it settles.)
  if (isTurn) {
    writeSessionCache(cacheFile, {
      ...readSessionCache(cacheFile),
      turns,
      pages: { atTurn: stale ? turns : (cached.pages?.atTurn ?? turns), list: pages },
    } satisfies SessionCache);
  }

  const blocks: string[] = [];
  // Hook-injected context lands in the USER MESSAGE and persists in the transcript — unlike a
  // system prompt, it accumulates. The memory block is injected exactly ONCE, on the step its
  // source answered. No cadence re-injection: replaying the turn-1 synthesis at arbitrary later
  // turns reads as random noise once the session drifts, and the agent holds hindsight_reflect for
  // a FRESH pass if compaction or drift makes it need memory again.
  if (delivery.body) blocks.push(buildSystemInjection(delivery.body));
  // Knowledge pages are NOT auto-injected: the agent pulls them through
  // hindsight_search_knowledge_pages when a question warrants it — an unprompted injection on
  // every turn (even a plain "yes") read as phantom research. The roster below keeps the tool
  // and the page names in front of the agent.
  if (isTurn && cadence > 0 && turns % cadence === 0) {
    blocks.push(
      buildRosterRefresh(pages, {
        reflectOnNewGoals: cfg.autoInject !== "reflect",
        extra: cfg.toolGuideExtra,
        harness,
      })
    );
  }
  const kept = blocks.filter(Boolean);

  // User-facing notice ONLY on a step that a source actually answered, showing its assigned goal
  // and a preview of what came back. Ordinary steps stay silent — page knowledge is pulled via the
  // hindsight_search_knowledge_pages tool, a visible tool call. A "fallback" body is deliberately
  // silent: the session still got memory, just not a synthesis, and saying which source answered
  // reads as an error on a step that worked (diag's reflect_failed + reflect_fallback_* carry it).
  let notice: string | undefined;
  if (delivery.body && (delivery.source === "synthesis" || delivery.source === "source")) {
    // The goal QUOTED is the one this body was produced for — this step's own prompt for a configured
    // retrieval source, and the turn that ASKED for the synthesis when one is collected late. A step
    // that happens to pick it up must not attribute the memory to a question it never saw. It is
    // always present on these two sources (a run is started only by a turn, and a retrieval source
    // only runs on one), so this needs no empty-goal branch.
    const q = (delivery.goal ?? prompt ?? "").replace(/\s+/g, " ").trim();
    const excerpt = q.length > 48 ? `${q.slice(0, 48)}…` : q;
    // Page/recall bodies open with a fixed lead line; preview what came back, not that.
    const body =
      delivery.source === "synthesis"
        ? delivery.body
        : delivery.body.split("\n").slice(1).join("\n");
    const preview = body.replace(/\s+/g, " ").trim();
    const tail = preview.length > 140 ? `${preview.slice(0, 140)}…` : preview;
    notice = `${brandWord()} · goal: recall this repo's past decisions about “${excerpt}”\n↳ ${tail}`;
  } else if (delivery.failed) {
    // The failure is already in the diag trail and plugin.log, but both are files nobody is
    // tailing mid-session, so a memory-less session looked exactly like a healthy one. One terse
    // line pointing at the trail — not an explanation, and not advice to the agent: this fires only
    // on a step that actually attempted a source, so at most the retry budget per session.
    notice = `${brandWord()} · no memory this turn — see ${diagFilePath()}`;
  }

  return { context: kept.length ? kept.join("\n\n") : undefined, notice, pages };
}

/** Run one hook invocation: stdin event in, (maybe) an injection object on stdout. */
export async function runHook(
  spec: HookSpec,
  makeClient: (opts: ClientOpts) => HookClient = (o) => new HindsightClient(o)
): Promise<void> {
  // Anti-recursion: the codebase survey's own headless session sets this so its hooks are a no-op.
  if (process.env.HINDSIGHT_DISABLE_HOOKS) return;

  const ev = readHookEvent(spec.harness);
  if (!ev) return;
  if (spec.accept && !spec.accept(ev)) return;
  const { prompt: rawPrompt, cwd: rawCwd, sessionId } = spec.parse(ev);
  if (spec.toolHook?.accept(ev)) {
    // Runs on every tool call, so it does nothing but hand over what a prompt hook stashed.
    const pending = sessionId ? takePendingContext(spec.harness, sessionId) : undefined;
    if (pending) process.stdout.write(JSON.stringify(spec.toolHook.emit(pending)));
    return;
  }
  if (spec.requireCwd && !rawCwd) return;
  const cwd = rawCwd || process.cwd();
  const prompt = (rawPrompt || "").trim();
  if (!prompt) return;

  let cfg = loadConfig({ harness: spec.harness });
  setLogLevel(cfg.logLevel);
  if (cfg.disabled) {
    log.debug(spec.harness, "hook skipped: disabled");
    return;
  }

  // Before any network work, and deliberately before the bank is resolved: the journal is this
  // session's only record of what the user said, and a slow or unreachable server must not be able
  // to cost the turn. Journaling under `retainSessions: false` writes a temp file nothing reads,
  // which is cheaper than threading that decision through two processes to find out.
  if (spec.journalPrompt) {
    appendJournalTurn(journalPath(spec.harness, sessionId), { role: "user", content: prompt });
  }

  const out = (context: string | undefined, notice?: string) =>
    process.stdout.write(JSON.stringify(spec.emit(context ?? "", notice, ev)));

  const sessionRoot = sessionRootDir(spec.harness, sessionId, cwd);
  const derived = deriveBankIdOrSkip(cfg, cwd, spec.harness, sessionRoot);
  if (derived === null) return; // repository unidentifiable: stay silent rather than invent a bank
  const resolved = applyBankConfig(cfg, derived, cwd);
  cfg = resolved.cfg;
  const bankId = resolved.bankId;
  if (cfg.disabled) {
    log.debug(spec.harness, "hook skipped: bank disabled via banks override", { bank: bankId });
    return;
  }
  const client = makeClient({
    apiUrl: cfg.apiUrl,
    apiToken: cfg.apiToken,
    bank: bankId,
    maxParallelRetains: cfg.maxParallelRetains,
    observationScopes: cfg.observationScopes,
    pageSearchLimit: cfg.pageSearchLimit,
    recallOptions: cfg.recallOptions,
  });
  const cacheFile = sessionCacheFile(spec.harness, sessionId || "no-session");

  // Safety net on EVERY harness: on the session's FIRST prompt (no cache file yet), fire the
  // ingestion engine. Normally the shared SessionStart lifecycle already did — the engine's
  // per-bank lock makes this a no-op — but a session that predates installation never received
  // SessionStart. This limited fallback heals that case without duplicating any survey logic.
  if (cfg.autoSeed !== false && !existsSync(cacheFile)) {
    startBackgroundSeed(cwd, { limit: cfg.seedLimit, harness: spec.harness });
  }

  const output = await buildStepOutput({
    harness: spec.harness,
    sessionId: sessionId || "no-session",
    prompt,
    cfg,
    client,
    // This process EXITS with the turn, so nothing could deliver a synthesis that outlived the
    // wait: waiting the whole `reflectTimeoutMs` is not a choice here, it is the only way a hook
    // harness can ever see a synthesis. That is the `Infinity` branch in core/auto-inject.ts, and
    // it is why hook-harness behaviour is unchanged by the wait/patience split.
    synthesis: new AutoInject({ patienceMs: Infinity }),
    cacheFile,
  });
  // Mid-session heal: a bank with ZERO pages means the engine never built it (e.g. the session
  // predates the install, so no SessionStart and the first-prompt net already passed). Fire the
  // idempotent engine — the per-bank lock makes repeats free while it builds.
  if (
    cfg.autoSeed !== false &&
    client.knowledgePagesSupported !== false &&
    output.pages.length === 0
  ) {
    startBackgroundSeed(cwd, { limit: cfg.seedLimit, harness: spec.harness });
  }
  let context = output.context;
  if (context && spec.toolHook && sessionId) {
    stashPendingContext(spec.harness, sessionId, context);
    context = undefined;
  }
  if (context || output.notice) out(context, output.notice);
}
