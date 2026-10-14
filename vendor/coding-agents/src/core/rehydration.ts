/**
 * Deciding what, if anything, to put back in front of the model after a compaction.
 *
 * Compaction is not a bug to be undone — it is how a long session keeps fitting in a window. So this
 * does not try to restore the span; it decides the cheapest thing that keeps the detail REACHABLE:
 *
 *   `handle`  a short pointer naming the span and the tool that reads it. Detail survives without
 *             paying context to keep it resident, which matters because an injected block lands in
 *             the durable history and is never removed — an eager re-injection is how a plugin
 *             makes the next compaction bigger than the one it just compensated for.
 *   `span`    the recovered text itself, and ONLY when a span actually looks relevant to the step
 *             in front of us. Relevance is file-path overlap with the step's tool calls: exact,
 *             deterministic, and free. A semantic match here would mean a network round-trip inside
 *             `agent/pre-step`, which is an awaited waterfall — every millisecond is the user's.
 *
 * The whole function is pure and synchronous: it reads the ledger the watcher already filled and
 * returns a decision. Nothing here touches the network, the clock, or the host.
 */
import type { CapturedSpan } from "./compaction-capture";
import type { ShadowSpan } from "./compaction-ledger";
import type { SessionLedger } from "./compaction-watcher";
import type { RehydrateMode } from "./config";

/**
 * The wrapper this plugin injects its rehydration blocks inside.
 *
 * It exists so `stripInjectedMemory` can remove the block from a later retain. Without that, the
 * recovered text would be re-extracted into the bank as though the agent had just said it — the
 * feedback loop that `transcript-util` already guards every other injected block against.
 */
export const REHYDRATION_TAG = "hindsight_compacted";

export type RehydrationKind = "handle" | "span";

export interface RehydrationDecision {
  kind: RehydrationKind;
  /** The block to inject, before the caller wraps it in {@link REHYDRATION_TAG}. */
  text: string;
  /** Span keys this decision accounts for. */
  keys: string[];
}

export interface RehydrateConfig {
  mode: RehydrateMode;
  /** Character cap on this one block. */
  maxChars: number;
  /** Character cap on recovered span text across the whole session. */
  sessionMaxChars: number;
  /** How many handle notes the session may receive in total. */
  maxHandles: number;
}

export interface RehydrateInput {
  ledger: SessionLedger | undefined;
  cfg: RehydrateConfig;
  /** Files this step's tool calls name. The only relevance signal used. */
  toolTargets?: readonly string[];
}

/** A span is relevant when it touched a file this step is working on. */
function relevantSpans(ledger: SessionLedger, toolTargets: ReadonlySet<string>): ShadowSpan[] {
  if (!toolTargets.size) return [];
  return ledger.spans.filter((span) => {
    if (ledger.delivered.has(span.key) || !ledger.captures.has(span.key)) return false;
    return (span.paths ?? []).some((path) => toolTargets.has(path));
  });
}

/**
 * One span's recovered turns, as plain text a model reads without needing a format explained.
 *
 * Exported because the read-back TOOL renders the same span the same way: a model that was shown
 * this text by `auto` and later asks for it by id must not receive a differently-shaped answer.
 * The DURABLE fallback (a restart, so the span is no longer in the ledger) can still be asked for by
 * id, and renders through {@link renderStoredSpanText} with the same `role: content` body — only the
 * header differs, because the span's surface bounds are no longer known.
 */
export function renderSpanText(span: ShadowSpan, captured: CapturedSpan): string {
  const header =
    `[compacted span ${span.key} — surface seqs ${span.start}..${span.end}, ` +
    `${span.tokens} tokens, ${span.kind}]`;
  return `${header}\n${renderTurnsText(captured.turns)}`;
}

/** The body shape both read-back paths share: one `role: content` line per recovered turn. */
function renderTurnsText(turns: readonly { role: string; content: string }[]): string {
  return turns.map((turn) => `${turn.role}: ${turn.content}`).join("\n");
}

/**
 * Render a span read back from the BANK (the JSONL document `spanDocument` wrote) in the same shape
 * as {@link renderSpanText}. The REF-ID system line leads every stored document and is dropped here:
 * it is addressing metadata, not something the model said.
 */
export function renderStoredSpanText(spanId: string, jsonl: string): string {
  const turns: { role: string; content: string }[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as { role?: unknown; content?: unknown };
      if (typeof parsed.role !== "string" || typeof parsed.content !== "string") continue;
      if (parsed.content.startsWith("REF-ID: ")) continue;
      turns.push({ role: parsed.role, content: parsed.content });
    } catch {
      // A line that is not JSON is not a turn; the caller still gets whatever parsed.
    }
  }
  return `[compacted span ${spanId} — retained copy]\n${renderTurnsText(turns)}`;
}

/**
 * The pointer block. Deliberately names the span, its size and the tool — a bare "something was
 * compacted" would leave the model unable to act on it, and reading is a tool call away.
 */
function handleNote(spans: readonly ShadowSpan[]): string {
  const lines = spans.map((span) => {
    const paths = span.paths?.length ? `, touches ${span.paths.slice(0, 4).join(", ")}` : "";
    return `- ${span.key}: ${span.tokens} tokens, ${span.kind}${paths}`;
  });
  return (
    "Context was compacted: earlier turns are no longer in your view, but they are recorded and " +
    "can be read back verbatim.\n" +
    `${lines.join("\n")}\n` +
    'Call hindsight_read_compacted({ span_id: "<id>" }) before re-deciding anything these may ' +
    "already have settled, or before telling the user a detail is unavailable."
  );
}

/**
 * The one block to inject for this step, or `undefined` when this step gets nothing.
 *
 * `auto` gets first refusal so a relevant span is delivered as text rather than merely named; a
 * handle is the fallback, and only while the session has handles left.
 */
export function planRehydration(input: RehydrateInput): RehydrationDecision | undefined {
  const { ledger, cfg } = input;
  if (cfg.mode === "off" || !ledger || !ledger.spans.length) return undefined;

  const remaining = cfg.sessionMaxChars - ledger.deliveredChars;
  if (cfg.mode === "auto" && remaining > 0) {
    const relevant = relevantSpans(ledger, new Set(input.toolTargets ?? []));
    if (relevant.length) {
      const text = relevant
        .map((span) => renderSpanText(span, ledger.captures.get(span.key)!))
        .join("\n\n");
      // Budget on the recovered text alone; the wrapper is a fixed few characters the caller owns.
      if (text.length <= Math.min(cfg.maxChars, remaining)) {
        return { kind: "span", text, keys: relevant.map((span) => span.key) };
      }
      // Too large to inject whole. Truncating a span would present a partial record as the complete
      // one, so it degrades to a handle and the model reads exactly what it needs instead.
    }
  }

  if (ledger.handles >= cfg.maxHandles) return undefined;
  const fresh = ledger.spans.filter((span) => !ledger.announced.has(span.key));
  if (!fresh.length) return undefined;
  return { kind: "handle", text: handleNote(fresh), keys: fresh.map((span) => span.key) };
}
