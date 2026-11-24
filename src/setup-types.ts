/**
 * The one-click setup's vocabulary, shared by both halves.
 *
 * The two halves talk through the settings document — the same channel the page already edits — so
 * the shapes here must be importable from both: this module therefore has NO runtime import at all
 * (no Schemastery, no node built-ins, nothing the browser bundle would have to stub). The host runs
 * the setup and writes a `setupStatus`; the browser reads it, parses it defensively, and turns the
 * stable codes into copy in the user's language.
 *
 * WHY A STRING FIELD. The status crosses as JSON text inside a config field. A nested Schemastery
 * shape would have to be kept in step with this file on the host side and would make a write fail
 * validation whenever the status gained a field; a string only has to be valid JSON, and a client
 * that does not understand a newer body degrades to "no status" instead of throwing.
 */

/** Where the setup currently is. `idle` means nothing has run in this profile yet. */
export type SetupPhase = "idle" | "running" | "ok" | "failed";

/** The steps the runner performs, as the client can localize them. */
export const SETUP_STEP_IDS = ["uv", "model", "service"] as const;
export type SetupStepId = (typeof SETUP_STEP_IDS)[number];

/** The codes a run can end with, as the client can localize them. */
export const SETUP_CODES = ["ok", "uv-missing", "model-missing", "unhealthy", "not-daemon", "error"] as const;
export type SetupCode = (typeof SETUP_CODES)[number];

/** One finished step: what it did, in one line the page shows verbatim. */
export interface SetupStepState {
  id: SetupStepId;
  ok: boolean;
  /** Already human-readable and deliberately free of secrets: a path, a model id, an elapsed time. */
  detail?: string;
}

/** What the local service ended up being, on success. Never carries a credential. */
export interface SetupServiceFacts {
  url: string;
  provider?: string;
  model?: string;
  /** Where the model came from, e.g. `dsh 当前模型` / `OPENAI_API_KEY`. Shown to the user. */
  source?: string;
}

/** The whole status, as written by the host and read by the page. */
export interface SetupStatus {
  /** Epoch ms of this write. The page uses it to tell a new answer from the one it already showed. */
  at: number;
  phase: SetupPhase;
  /** The step in flight while `phase` is `running`. */
  step?: SetupStepId;
  code?: SetupCode;
  /** One line of raw detail for the failure case (an installer message, a URL, a timeout). */
  detail?: string;
  steps: SetupStepState[];
  service?: SetupServiceFacts;
  elapsedMs?: number;
}

/** Parse a status body that arrived from the settings document, tolerating anything else. */
export function parseSetupStatus(raw: unknown): SetupStatus | undefined {
  if (typeof raw !== "string" || raw.trim() === "") return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return undefined;
    const candidate = value as Partial<SetupStatus>;
    if (typeof candidate.at !== "number" || typeof candidate.phase !== "string") return undefined;
    if (!["idle", "running", "ok", "failed"].includes(candidate.phase)) return undefined;
    // `code` and `step` localize through fixed keys (`setupReason.${code}`, `setupStep.${step}`):
    // an unknown value from a newer host must not reach the page, where it renders as a bare key
    // the user cannot read. Dropped, not substituted — the phase still says what happened.
    if (candidate.code !== undefined && !(SETUP_CODES as readonly string[]).includes(candidate.code)) {
      candidate.code = undefined;
    }
    if (candidate.step !== undefined && !(SETUP_STEP_IDS as readonly string[]).includes(candidate.step)) {
      candidate.step = undefined;
    }
    return {
      at: candidate.at,
      phase: candidate.phase as SetupPhase,
      step: candidate.step,
      code: candidate.code,
      detail: candidate.detail,
      steps: Array.isArray(candidate.steps) ? candidate.steps : [],
      service: candidate.service,
      elapsedMs: candidate.elapsedMs,
    };
  } catch {
    return undefined;
  }
}

/** Serialize for the settings write. Kept here so both halves agree on the shape. */
export function serializeSetupStatus(status: SetupStatus): string {
  return JSON.stringify(status);
}
