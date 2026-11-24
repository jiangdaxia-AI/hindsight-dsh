/**
 * Host adapter runtime for PERSISTENT-PLUGIN harnesses (opencode, opencode2, Kilo, Cline, dsh, pi,
 * Prime Agent — every host that loads us once and keeps us). It delegates SessionStart and
 * prompt behavior to the same core lifecycle as fresh-process hook harnesses; this class keeps only
 * the host-specific injection, toast, and incremental-transcript responsibilities.
 *
 * A harness adapter feeds it three normalized events and reads values back:
 *   - seedIfCold(repoPath)          : plugin load -> cold-check auto-seed (the page preamble is
 *                                     NOT computed here; stepContext builds it per session)
 *   - stepContext(sessionId, prompt): EVERY step -> this step's injection, and the only way a
 *                                     synthesis that outlived its step's wait is ever delivered
 *   - disposeSession(sessionId)     : the host disposed the session -> forget its local state
 *   - toolSpecs()                   : the hindsight_* knowledge/recall tools to register natively
 *
 * WHY ONE CALL PER STEP AND NOT PER PROMPT. The adapter used to ask twice — `onPrompt` to run the
 * recall, `getInjection` to collect it — and only on steps that carried a prompt, on the assumption
 * that a tool continuation already had the block in its history. That assumption is false the
 * moment the memory is allowed to arrive LATE, which is exactly what makes a slow synthesis cheap:
 * the block a continuation needs has not been injected anywhere yet. One call per step, prompt or
 * not, is the smallest interface that can express both.
 *   - onTranscript(sessionId, turns, lastTurnComplete): full transcript -> write back (on by default)
 *   - onSessionIdle(sessionId)      : assistant finished -> refetch + write back the completed
 *                                     exchange (the Stop-equivalent these hosts lack)
 *   - flush()                       : host is exiting -> wait (bounded) for in-flight write-backs
 * No opencode/claude specifics live here — only the memory logic.
 */
import type { Config } from "./config";
import { AutoInject } from "./auto-inject";
import { maybeAutoUpdate } from "./auto-update";
import { DAEMON_WAIT_RETAIN_MS, DAEMON_WAIT_SESSION_START_MS, ensureDaemon } from "./daemon";
import { diag } from "./diag";
import { describeError, log, setLogLevel } from "./log";
import type { HindsightClient } from "./hindsight";
import { buildKnowledgePreamble } from "./knowledge-injection";
import { buildKnowledgeTools, type ToolSpec } from "./knowledge-tools";
import { buildPageTrigger } from "./missions";
import { retainLiveSession, type TransportTurn } from "./chat";
import { memoryCursorStore } from "./retain-cursor";
import { memoryUsageCursorStore, recordUsage } from "./usage";
import { buildRetainStamp } from "./retain-stamp";
import { buildSessionStartContext } from "./session-start";
import { syncCompanionSkill } from "./skill-sync";
import { buildStepOutput } from "./hook";
import { readSessionCache, sessionCacheFile, writeSessionCache } from "./session-cache";

const HARNESS = "opencode";
/** How long `flush` holds a host's exit for in-flight write-backs: room for one retain request. */
const FLUSH_TIMEOUT_MS = 10_000;

export class RuntimeCore {
  private readonly turnCount = new Map<string, number>(); // sessionId -> user-turn counter (cadence)
  private readonly sessionState = new Map<string, { startTs: string; retainedTurns: number }>();
  /** Live write-back cursors. In memory, unlike the hook harnesses': this host outlives the session. */
  private readonly cursors = memoryCursorStore();
  /** Turns already written to the usage log (core/usage.ts), per session. */
  private readonly usageCursors = memoryUsageCursorStore();
  /** Pulls a session's CURRENT transcript from the host (set by the adapter); see onSessionIdle. */
  private fetchTranscript?: (sessionId: string) => Promise<TransportTurn[]>;
  /** Write-backs started and not yet settled — what `flush` waits for. */
  private readonly inFlight = new Set<Promise<void>>();
  /**
   * This host's automatic injection, shared across its sessions because the state it keeps is per
   * session and IS the delivery channel for a synthesis that outlived its step's wait.
   *
   * `reflectPatienceMs` is the whole difference between this host and a hook harness: this process
   * outlives the step, so an answer that arrives after the wait can still be handed to a later step.
   * A hook harness has nowhere to put it and passes `Infinity` (see core/hook.ts).
   */
  private readonly synthesis: AutoInject;
  private deferInitialReflect = false;
  /**
   * Which sessions have already taken their own copy of the cold-bank deferral. The core-level
   * flag is per-BANK (seedIfCold has no session id) but the deferral itself is per-SESSION, so a
   * multi-session host needs to know which sessions have had theirs; see `stepContext`.
   */
  private readonly deferredSessions = new Set<string>();
  /** Host-notice channel (opencode/Kilo: client.tui.showToast via the adapter). Optional, fail-open. */
  private notify?: (title: string, message: string) => void;

  constructor(
    private readonly client: HindsightClient,
    private readonly bankId: string,
    private readonly cfg: Config,
    /**
     * Which persistent-plugin host loaded us. Scopes diagnostics, the session cache file and the
     * retained transcript's harness field, so Kilo sessions don't masquerade as opencode ones.
     * Defaults to opencode, the original (and only other) plugin harness.
     */
    readonly harness: string = HARNESS,
    /** Workspace root this host opened — the SAME directory bank resolution used, so a
     *  `{gitProject}` in retainTags names the repo the bank was derived from. */
    private readonly projectDir: string = process.cwd()
  ) {
    setLogLevel(cfg.logLevel);
    // Read off this workspace's Config, so a repo with its own `banks.<id>` override gets its own
    // patience — the same reason every other budget here is resolved from `cfg` and not from a
    // process-wide default.
    this.synthesis = new AutoInject({ patienceMs: cfg.reflectPatienceMs });
  }

  setNotifier(notify: (title: string, message: string) => void): void {
    this.notify = notify;
  }

  /**
   * Supply a way to READ the session's transcript back from the host. Without it `onSessionIdle`
   * no-ops, so hosts that can't refetch keep the old (lagging) turn-driven write-back rather than
   * retaining a stale transcript.
   */
  setTranscriptSource(fetch: (sessionId: string) => Promise<TransportTurn[]>): void {
    this.fetchTranscript = fetch;
  }

  /** The hindsight_* knowledge + recall tools, bound to this bank, for the harness to register natively. */
  toolSpecs(): ToolSpec[] {
    return buildKnowledgeTools(this.client, this.bankId, {
      repoDir: this.projectDir,
      harness: this.harness,
      pageTrigger: buildPageTrigger(this.cfg),
      reflectTimeoutMs: this.cfg.reflectToolTimeoutMs,
      reflectBudget: this.cfg.reflectBudget,
      toolGuideExtra: this.cfg.toolGuideExtra,
      stampFor: () =>
        buildRetainStamp(this.cfg, {
          directory: this.projectDir,
          harness: this.harness,
          bankId: this.bankId,
        }),
    });
  }

  get writeBackEnabled(): boolean {
    return this.cfg.retainSessions;
  }

  /**
   * Plugin load (SessionStart-equivalent): on a cold repo, deterministically start the background
   * git-log seed + codebase survey. Reuses the exact hook-harness logic
   * (`buildSessionStartContext`) so opencode seeds identically. Never throws.
   *
   * It deliberately does NOT keep that call's knowledge preamble. This runs once per PROCESS and
   * these hosts outlive every session, so a roster captured here is stale for every session but
   * the first — `stepContext` builds its own from the session's live page list (#4607).
   */
  async seedIfCold(repoPath: string | undefined): Promise<void> {
    // Anti-recursion: a headless survey session runs the agent (which loads this plugin) with
    // HINDSIGHT_DISABLE_HOOKS=1 — the tools stay registered (toolSpecs, so the survey can ingest),
    // but seeding/recall/write-back must no-op or the survey would re-seed itself (see core/survey.ts).
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return;
    // Companion skill, the same housekeeping `runSessionStartHook` does for hook harnesses — but
    // with `install`, because a persistent-plugin host can be wired by its OWN plugin manager
    // (`dsh plugin add …`, `cline plugin install`), a route our installer never sees, leaving the
    // plugin loaded with its tools registered and no skill on disk at all (#4406). No-op for a host
    // with no skills directory (opencode; opencode2 registers it in memory instead).
    syncCompanionSkill(this.harness, { install: true });
    // Daemon mode: this is the SessionStart of a persistent-plugin host, so it owns the same
    // warm-up the hook harnesses do in `runSessionStartHook` — start it before the user has typed
    // anything, wait only briefly, and let a cold one keep coming up in the background. Without it
    // these hosts never started a daemon at all and every request failed with ECONNREFUSED (#3524);
    // `runSessionStartHook` is a hook-only wrapper, so calling `buildSessionStartContext` directly
    // (as every plugin harness does) skipped the ensure entirely.
    await ensureDaemon(this.cfg, this.harness, { waitMs: DAEMON_WAIT_SESSION_START_MS });
    // Same session-start housekeeping the hook harnesses do in `runSessionStartHook`: a persistent
    // plugin host is a session start too, and leaving it out would mean opencode/Kilo/Cline users
    // never got an update — the parity gap `ensureDaemon` above already had to be fixed for.
    void maybeAutoUpdate(this.cfg);
    try {
      const out = await buildSessionStartContext({
        cwd: repoPath || process.cwd(),
        bankId: this.bankId,
        cfg: this.cfg,
        client: this.client,
        harness: this.harness,
      });
      // The seed note is user-facing; opencode has no visible-system channel at load, so surface it
      // on stderr (shows in the plugin log / console) rather than dropping it.
      // Banner: via the host's toast API when available (stderr corrupts the TUI); always logged.
      if (out.systemMessage) {
        const plain = out.systemMessage.replace(/\x1b\[[0-9;]*m/g, "");
        log.info(this.harness, plain);
        this.notify?.("Hindsight", plain.replace(/^Hindsight is /, "Is "));
      }
      this.deferInitialReflect = out.deferInitialReflect === true;
    } catch {
      /* seeding is best-effort — a cold-check failure never breaks the agent */
    }
  }

  /**
   * This STEP's injection, or undefined when it has nothing to inject.
   *
   * Call it on every step, `prompt` or not: a step with no prompt is a tool continuation, and it is
   * the delivery channel for a synthesis that finished after the step that asked for it stopped
   * waiting (see core/auto-inject.ts). A step WITH a prompt counts as a turn — it advances the
   * cadence and is the only kind of step that can start a source.
   *
   * Delegates to the same `buildStepOutput` hook harnesses use, so the lifecycle behaviour is shared
   * rather than reimplemented; the difference is the `AutoInject` this host passes it, whose patience
   * is finite because this process survives the step.
   */
  async stepContext(
    sessionId: string | undefined,
    prompt?: string
  ): Promise<{ context?: string; notice?: string }> {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return {}; // anti-recursion (see seedIfCold)
    if (!sessionId) return {};
    const turn = prompt !== undefined && prompt.trim() !== "";
    const turns = turn ? (this.turnCount.get(sessionId) ?? 0) + 1 : (this.turnCount.get(sessionId) ?? 0);
    if (turn) this.turnCount.set(sessionId, turns);

    const cacheFile = sessionCacheFile(this.harness, sessionId);
    if (turn && this.deferInitialReflect && this.deferredSessions.add(sessionId)) {
      // `seedIfCold` has no session id, so its cold-bank decision is transferred to each concrete
      // session here — ONCE PER SESSION, exactly like the hook harnesses' SessionStart does. The
      // core-level flag is deliberately NOT consumed: a persistent host runs several sessions over
      // one cold bank (dsh's Web UI opens two agents on one repo), and the first session taking
      // the flag left the second one synthesizing straight into a brand-new bank — the very
      // thing the deferral exists to prevent. The flag falls when the NEXT cold-check says the
      // bank is no longer new (`seedIfCold` overwrites it either way).
      writeSessionCache(cacheFile, { deferInitialReflect: true });
    }
    const output = await buildStepOutput({
      harness: this.harness,
      sessionId,
      prompt: turn ? prompt : undefined,
      cfg: this.cfg,
      client: this.client,
      synthesis: this.synthesis,
      cacheFile,
    });

    const blocks: string[] = [];
    // The SessionStart-equivalent preamble, injected once on the first turn (later turns get the
    // periodic refresh below). Built HERE, from this session's own roster, rather than reused from
    // plugin load: that one is a process-lifetime snapshot, so a host started before the pages
    // existed told every later session "No knowledge pages yet" while the same turn's memory block
    // listed pages by id (#4607).
    if (turn && turns === 1) {
      blocks.push(
        buildKnowledgePreamble(output.pages, {
          reflectOnNewGoals: this.cfg.autoInject !== "reflect",
          extra: this.cfg.toolGuideExtra,
          harness: this.harness,
        })
      );
    }
    if (output.context) blocks.push(output.context);
    // OpenCode has no user-message hook channel; use its native toast instead of stderr, which
    // renders inside the TUI input line. The shared output owns when a notice exists.
    if (output.notice) {
      const preview = output.notice.replace(/\s+/g, " ").trim().slice(0, 140);
      log.info(this.harness, "reflect goal", { preview });
      this.notify?.("Hindsight · recalled past decisions", preview);
    }
    const block = blocks.filter(Boolean).join("\n\n");
    return block ? { context: block, notice: output.notice } : { notice: output.notice };
  }

  /**
   * The host disposed this session: drop what this process was keeping for it, so a long-lived
   * server does not pin one entry per session it ever opened. A synthesis still in flight is NOT
   * cancelled — it settles and records its answer in the session cache, where a later process finds
   * it, which is strictly better than the answer disappearing with the bookkeeping.
   *
   * The cache's TURN COUNTER is reset with the in-memory one, on purpose: this host derives
   * "turn 1" (the preamble boundary) from memory and the roster cadence from the cache file, and a
   * resumed session reusing the same id would otherwise start at memory-turn-1 with a cache saying
   * turn 5 — injecting the first-turn preamble AND a cadence refresh on the same step, and staying
   * one apart from there. Cleared together, the two counters cannot disagree at any boundary.
   */
  disposeSession(sessionId: string): void {
    this.synthesis.dispose(sessionId);
    this.turnCount.delete(sessionId);
    this.sessionState.delete(sessionId);
    this.deferredSessions.delete(sessionId);
    try {
      const cacheFile = sessionCacheFile(this.harness, sessionId);
      const cached = readSessionCache(cacheFile);
      if (cached.turns !== undefined || cached.pages !== undefined) {
        const { turns: _t, pages: _p, ...rest } = cached;
        writeSessionCache(cacheFile, rest);
      }
    } catch {
      /* a cache file this cannot rewrite is the pre-existing behaviour: nothing further */
    }
  }

  /**
   * Full normalized transcript (rich: user/assistant text + tool calls/outputs): upsert every turn
   * when enabled. On by default for persistent-plugin hosts (parity with hook-harness Stop
   * write-back), so opencode sessions compound into memory; opt out with `retainSessions: false`.
   *
   * There is deliberately no client-side cadence. Batching write-backs meant holding turns in a
   * process the host can close at any moment, with no reliable signal on the way out — the flush a
   * cadence needs would have to ride a session-end hook, and those are cancelled at shutdown. The
   * server coalesces instead: queued retains for one document fold into a single execution
   * (`engine.retain.fold`), so submitting every turn costs one extraction, not one per turn, and
   * nothing is ever held somewhere it can be lost.
   */
  async onTranscript(
    sessionId: string,
    turns: TransportTurn[],
    /** Whether the agent has finished answering the last prompt. Required, not defaulted: opencode
     *  hands this over while BUILDING a request (false), pi and Cline after the run ends (true), and
     *  a wrong default records every turn one late and never the session's last. */
    lastTurnComplete: boolean
  ): Promise<void> {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return; // anti-recursion (see seedIfCold)
    if (!sessionId || !turns.length) return;
    // Usage is a local file, so it is recorded whether or not write-back is on (#5391).
    this.recordUsage(sessionId, turns, lastTurnComplete);
    if (!this.writeBackEnabled) return;
    const st = this.stateFor(sessionId);
    this.retain(sessionId, turns, st.startTs);
  }

  /**
   * Session went idle — the assistant has finished replying.
   *
   * This is the Stop-equivalent these hosts lack. `onTranscript` alone is driven by
   * `messages.transform`, which the host runs while BUILDING a request, so the transcript it hands
   * us never contains the reply that request produced: write-back always lagged one user turn, and
   * a session's final exchange was never retained at all. Refetching here (rather than replaying a
   * cached list) is the whole point — the cached one predates the reply.
   *
   * Cadence is deliberately bypassed: idle means "there may be nothing after this", so a pending
   * turn must not wait for a threshold it will never reach.
   */
  async onSessionIdle(sessionId: string): Promise<void> {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return; // anti-recursion (see seedIfCold)
    if (!sessionId || !this.fetchTranscript) return;
    let turns: TransportTurn[];
    try {
      turns = await this.fetchTranscript(sessionId);
    } catch (e) {
      diag(this.harness, "idle_fetch_failed", {
        error: describeError(e),
        session: sessionId,
      });
      return;
    }
    this.retainIfGrown(sessionId, turns, "idle");
  }

  /**
   * Retain an ALREADY-FETCHED transcript if it grew past the last write, recording its usage.
   *
   * Split out of `onSessionIdle` so a host that can read the transcript SYNCHRONOUSLY can take a
   * last snapshot at a teardown boundary (dsh's `agent/disposed`, where the live agent is still
   * attached but is about not to be) without racing the idle path's async fetch: whichever path
   * gets there first wins the dedupe gate and the loser is a no-op, so the two cannot double-write
   * either. The race this closes: `agent/turn-stopping` starts an async refetch, the host fires
   * `agent/disposed` before it settles, disposal drops the live-agent entry, the fetch comes back
   * empty — and the session's final exchange was never retained at all.
   */
  retainIfGrown(sessionId: string, turns: TransportTurn[], trigger = "idle"): void {
    if (process.env.HINDSIGHT_DISABLE_HOOKS) return;
    if (!sessionId || !turns.length) return;
    this.recordUsage(sessionId, turns, true); // the caller's snapshot includes the reply
    if (!this.writeBackEnabled) return; // usage above is local and recorded regardless (#5391)
    const st = this.stateFor(sessionId);
    // idle can fire more than once for one exchange (and again on a session with no new activity);
    // only retain when this transcript actually grew past what we last wrote.
    if (turns.length <= st.retainedTurns) return;
    st.retainedTurns = turns.length;
    this.retain(sessionId, turns, st.startTs, trigger);
  }

  private recordUsage(sessionId: string, turns: TransportTurn[], lastTurnComplete: boolean): void {
    recordUsage({
      harness: this.harness,
      sessionId,
      bankId: this.bankId,
      turns,
      cursors: this.usageCursors,
      lastTurnComplete,
      // No `reviseLastTurn` here, unlike the hook path: this runtime never records a turn before its
      // reply exists. `onTranscript` is handed `false` while the host is still building the request,
      // which holds the turn back, and `onSessionIdle` refetches a transcript that includes the
      // reply before recording it.
    });
  }

  private stateFor(sessionId: string): {
    startTs: string;
    retainedTurns: number;
  } {
    let st = this.sessionState.get(sessionId);
    if (!st) {
      st = { startTs: new Date().toISOString(), retainedTurns: 0 };
      this.sessionState.set(sessionId, st);
    }
    return st;
  }

  /**
   * Wait for every write-back still in flight, at most `timeoutMs` overall. Write-backs stay
   * fire-and-forget so a turn never blocks on the network; a host that announces its exit (pi's
   * `session_shutdown`) calls this so the session's final retain is not dropped with the process
   * (#5081). Bounded so a stalled server cannot hold the host's exit open. Never throws.
   *
   * LOOPS rather than racing one snapshot: a retain spends up to `DAEMON_WAIT_RETAIN_MS` on
   * `ensureDaemon` BEFORE its promise joins `inFlight`, so a single `Promise.all(this.inFlight)`
   * taken at entry would miss a write-back that started moments earlier and is still in its
   * daemon wait — exactly the unload window this exists to cover. Each pass waits for whatever
   * is in the set NOW; when it drains, a set that has grown again gets another pass, until the
   * budget is spent.
   */
  async flush(timeoutMs = FLUSH_TIMEOUT_MS): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.inFlight.size) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.all([...this.inFlight]),
        new Promise<void>((r) => {
          timer = setTimeout(r, remaining);
        }),
      ]);
      clearTimeout(timer);
    }
  }

  /**
   * Fire-and-forget retain of one ALREADY-BUILT document, tracked like every other write-back so
   * `flush` waits for it.
   *
   * The caller owns the shape (see core/compaction-watcher.ts and core/code-facts.ts) and this
   * deliberately takes a structural type rather than importing it: RuntimeCore is the
   * harness-agnostic core, while both documents that use this today are dsh-specific. Unlike the
   * conversation write-back it applies NO retain stamp — the caller passes the tags it wants, which
   * is why a caller that wants the user's `retainTags` must supply them (see dsh.ts `stampFor`).
   */
  retainDocument(input: {
    documentId: string;
    content: string;
    context: string;
    tags: string[];
    metadata: Record<string, string>;
  }): void {
    const t0 = Date.now();
    const write = ensureDaemon(this.cfg, this.harness, { waitMs: DAEMON_WAIT_RETAIN_MS })
      .then(() =>
        this.client.retain(
          input.content,
          input.context,
          input.documentId,
          input.tags,
          "conversation",
          {
            metadata: input.metadata,
          }
        )
      )
      .then(() => diag(this.harness, "retain_ok", { ms: Date.now() - t0, doc: input.documentId }))
      .catch((e) =>
        diag(this.harness, "retain_failed", {
          ms: Date.now() - t0,
          doc: input.documentId,
          error: describeError(e),
        })
      );
    this.inFlight.add(write);
    void write.finally(() => this.inFlight.delete(write));
  }

  /** Read one retained document's text back. The durable half of compacted-span recovery. */
  async readDocument(documentId: string): Promise<string | undefined> {
    return this.client.documentText(documentId);
  }

  /** Fire-and-forget upsert of the session transcript; never throws into the host. */
  private retain(
    sessionId: string,
    turns: TransportTurn[],
    startTs: string,
    trigger = "turn"
  ): void {
    const t0 = Date.now();
    // Daemon mode: the write path is the last chance to get a daemon up — the Stop-hook role, for
    // hosts that have no Stop hook. A daemon that died mid-session would otherwise take the whole
    // exchange with it. The wait sits INSIDE the fire-and-forget chain, so
    // unlike the Stop hook it costs the host nothing: this call already returns before the retain
    // does. Deliberately not gated on the result — retain proceeds either way, so an unreachable
    // daemon produces the same `retain_failed` diagnostic as an unreachable Cloud server.
    const write = ensureDaemon(this.cfg, this.harness, { waitMs: DAEMON_WAIT_RETAIN_MS })
      .then(() =>
        retainLiveSession(this.client, sessionId, turns, startTs, this.harness, {
          cursors: this.cursors,
          stamp: buildRetainStamp(this.cfg, {
            directory: this.projectDir,
            harness: this.harness,
            bankId: this.bankId,
            sessionId,
          }),
        })
      )
      .then(() =>
        diag(this.harness, "retain_ok", {
          ms: Date.now() - t0,
          turns: turns.length,
          session: sessionId,
          trigger,
        })
      )
      .catch((e) =>
        diag(this.harness, "retain_failed", {
          ms: Date.now() - t0,
          error: describeError(e),
          session: sessionId,
          trigger,
        })
      );
    this.inFlight.add(write);
    void write.finally(() => this.inFlight.delete(write));
  }
}
