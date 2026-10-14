/**
 * The compaction ledger: what dsh threw away from the model's surface, and where to get it back.
 *
 * Compaction in dsh is NON-DESTRUCTIVE to storage and destructive to the SURFACE. A session is an
 * append-only log; `surface` is the derived view the model is actually sent, and a compaction
 * appends one event carrying `surfaceOp: { op: 'replace', startSeq, endSeq }` that swaps a span of
 * surface nodes for a single summary node. `Session.eventAt(seq)` indexes the LOG, so every
 * shadowed event is still readable afterwards — that is the whole reason this feature can exist.
 *
 * `compaction/*` are durable SESSION EVENT types, not Cordis events: dsh's own docs say so
 * ("需要观察它们时，监听 `session/event` 并检查 `event.type`"). This module is the pure half of that —
 * it turns the event stream's compaction records into spans, and owns no I/O, no clock and no host.
 *
 * Two payload shapes matter, and they are NOT the same:
 *
 *   'compaction/summary': { compactionId, sourceCommandId?, summary: ContentBlock[], shadowedRange,
 *                           shadowedSeqs, shadowedTokenCount, provider, model, ... }
 *   'compaction/prune':   { shadowedRange, shadowedSeqs, shadowedTokenCount }
 *
 * NEITHER carries the owning `turn`: the host puts that on 'compaction/start'/'compaction/end'
 * (verified against the Harness SessionEventMap). So `spanFromEvent` leaves `turn` null and the
 * watcher fills it in from the `compaction/start` it saw for the same compactionId.
 *
 * `shadowedSeqs` is the exact list of replaced seqs and is what we use; `shadowedRange` is only the
 * coarse envelope. The distinction is load-bearing: a replace can produce a surface whose visible
 * seqs are non-monotonic, so iterating `[start..end]` would resolve seqs the compaction never
 * touched and could miss ones it did. A `prune` carries no `compactionId` at all, which is why the
 * span key falls back to the event's own seq.
 */
import type { DshSessionEvent } from "./transcript-dsh";

export type CompactionKind = "summary" | "prune";

/** One span dsh removed from the model's surface, and the identity needed to ask for it back. */
export interface ShadowSpan {
  kind: CompactionKind;
  /**
   * Stable identity, unique within a session: `compactionId` when the event carried one, else the
   * event's own seq (`prune` has no id). This is what a delivered-handle set and the retained
   * document id are keyed on, so it must not change between the live ledger and one rebuilt from a
   * restored session log.
   */
  key: string;
  compactionId?: string;
  /** The exact surface seqs that were replaced, ascending. */
  seqs: number[];
  /** Coarse bounds from `shadowedRange`; equal to the seq extremes only for a contiguous replace. */
  start: number;
  end: number;
  /** Tokens the host says this removed from the surface — exact, not estimated. */
  tokens: number;
  /**
   * Owning turn, filled in by the watcher from the `compaction/start` for the same compactionId.
   * null when that opener was never seen (a span seeded from a restored log, or a prune, which
   * carries no compactionId at all).
   */
  turn: number | null;
  /** The compaction event's own seq — the address of the compaction itself. */
  seq: number;
  /** The summary the host wrote in place of the span, when the event carried one. */
  summary?: string;
  /**
   * Absolute-looking file paths mentioned in the span, filled in by the capture step and used only
   * for relevance matching. Empty when the span was never captured.
   */
  paths?: string[];
}

/** `ContentBlock[]` carries the summary and raw model output; text is the only part we can use. */
function textOfBlocks(blocks: unknown): string | undefined {
  if (!Array.isArray(blocks)) return undefined;
  const text = blocks
    .map((block) => {
      if (!block || typeof block !== "object") return "";
      const typed = block as { type?: unknown; text?: unknown };
      return typed.type === "text" && typeof typed.text === "string" ? typed.text : "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
  return text || undefined;
}

/** Finite numbers only — a malformed seq would otherwise poison every later lookup. */
function seqList(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  for (const value of raw) {
    if (typeof value === "number" && Number.isFinite(value)) seen.add(value);
  }
  return [...seen].sort((a, b) => a - b);
}

/** `[start..end]` inclusive, for a host that reported only the envelope. */
function seqRange(start: number, end: number): number[] {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const out: number[] = [];
  // A compaction is bounded by the context window, so this cannot run away; the guard is for a
  // malformed payload that claims a preposterous range.
  const limit = Math.min(end, start + 100_000);
  for (let seq = start; seq <= limit; seq++) out.push(seq);
  return out;
}

/**
 * Turn one session event into a span, or `undefined` when it is not a compaction record.
 *
 * Never throws: a malformed payload yields `undefined` rather than taking down an observer that
 * runs inside the host's append path.
 */
export function spanFromEvent(event: DshSessionEvent | undefined): ShadowSpan | undefined {
  if (!event || typeof event !== "object") return undefined;
  const kind =
    event.type === "compaction/summary"
      ? "summary"
      : event.type === "compaction/prune"
        ? "prune"
        : undefined;
  if (!kind) return undefined;

  const data = (event.data ?? {}) as {
    compactionId?: unknown;
    turn?: unknown;
    summary?: unknown;
    shadowedRange?: { start?: unknown; end?: unknown };
    shadowedSeqs?: unknown;
    shadowedTokenCount?: unknown;
  };

  const range = data.shadowedRange;
  const start = typeof range?.start === "number" ? range.start : undefined;
  const end = typeof range?.end === "number" ? range.end : undefined;

  const seqs = seqList(data.shadowedSeqs);
  // Prefer the exact list. Fall back to the envelope only when the host did not send one.
  const resolved = seqs.length
    ? seqs
    : start !== undefined && end !== undefined
      ? seqRange(start, end)
      : [];
  if (!resolved.length) return undefined;

  const compactionId = typeof data.compactionId === "string" ? data.compactionId : undefined;
  const eventSeq = typeof event.seq === "number" ? event.seq : -1;
  const summaryText = kind === "summary" ? textOfBlocks(data.summary) : undefined;

  return {
    kind,
    // `seq:${eventSeq}` is unique because a session log appends each event exactly once; a `prune`
    // with no id would otherwise collide with every other prune on the same key.
    key: compactionId ?? `seq:${eventSeq}`,
    ...(compactionId ? { compactionId } : {}),
    seqs: resolved,
    start: start ?? resolved[0],
    end: end ?? resolved[resolved.length - 1],
    tokens: typeof data.shadowedTokenCount === "number" ? data.shadowedTokenCount : 0,
    turn: typeof data.turn === "number" ? data.turn : null,
    seq: eventSeq,
    ...(summaryText ? { summary: summaryText } : {}),
  };
}
