/**
 * The one description of the wire between this plugin's settings page and its host half.
 *
 * Kept free of every runtime import — no `node:*`, no memory engine, no Schemastery — because BOTH
 * halves read it: the host half builds these payloads, and the browser half parses them. A copy of
 * the route string or of a field name in the client is how a page starts reading a key the host
 * stopped sending, and the failure looks like "no libraries" rather than like a bug.
 *
 * THE ROUTE IS AN EXACT FETCH ROUTE on the Host's connection service, not a settings write. See
 * `bank-admin.ts` for why a list and a delete do not belong in the settings document.
 */

/**
 * The path the host registers on the connection service.
 *
 * A constant because the host route, the browser caller and the tests must agree on it, and a
 * mismatch is a 404 that looks like a dead plugin.
 */
export const LIBRARY_ROUTE = "/api/hindsight/libraries";

/**
 * The same route as the BROWSER spells it: document-relative, with no leading slash.
 *
 * App routes resolve against the document's own base, not the origin root, so a deployment mounted
 * under a prefix keeps working. This is the platform's convention for every browser-side caller —
 * see the `FILE_UPLOAD_ROUTE` derivation in `@deepseek-ai/dsh-client-file-upload` — which is why the
 * leading `/` comes off here rather than in a component.
 */
export const LIBRARY_CLIENT_ROUTE = LIBRARY_ROUTE.slice(1);

/** One library as the page renders it. */
export interface LibraryRow {
  bankId: string;
  /** What the row is titled with: the server's own name for the bank, or its id. */
  label: string;
  /** Facts extracted into the bank. */
  factCount: number;
  /**
   * Retained sessions — documents keyed `conversation:<sessionId>`.
   *
   * `null` means the count could not be read while the rest of the list could: one unanswerable
   * number must not be reported as zero sessions.
   */
  sessions: number | null;
  createdAt?: string;
  lastWriteAt?: string;
}

/** The listing the page renders. */
export interface LibrariesPayload {
  ok: true;
  /** The server the list came from, so the page can say which one it is showing. */
  endpoint: string;
  /** The configured mode, which explains an empty list better than "no libraries". */
  serverMode: string;
  /** True when memory is switched off — the list still works, but the page says so. */
  disabled: boolean;
  /** Whether banks this integration did not create are included. */
  all: boolean;
  /** Every bank on the server, and how many this listing left out. */
  total: number;
  hidden: number;
  fetchedAt: string;
  libraries: LibraryRow[];
}

/** Everything that can go wrong, as the page reads it. */
export interface LibrariesFailure {
  ok: false;
  /**
   * `unreachable`: the server did not answer, or answered with an error body.
   * `bad-request`: the page asked for something the route does not do.
   * `refused`: the delete guard rejected the id — it is not a bank the server is showing.
   */
  code: "unreachable" | "bad-request" | "refused";
  error: string;
}

export type LibrariesResponse = LibrariesPayload | LibrariesFailure;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** One row off the wire, or undefined when it does not carry the two fields a row needs. */
function libraryOf(value: unknown): LibraryRow | undefined {
  if (!isRecord(value)) return undefined;
  if (typeof value.bankId !== "string" || value.bankId === "") return undefined;
  const text = (key: string): string | undefined => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  return {
    bankId: value.bankId,
    label: typeof value.label === "string" && value.label !== "" ? value.label : value.bankId,
    factCount: typeof value.factCount === "number" ? value.factCount : 0,
    // Absent and `null` both mean "not known"; a number is the only thing that means a count.
    sessions: typeof value.sessions === "number" ? value.sessions : null,
    ...(text("createdAt") === undefined ? {} : { createdAt: text("createdAt") }),
    ...(text("lastWriteAt") === undefined ? {} : { lastWriteAt: text("lastWriteAt") }),
  };
}

/**
 * Read the host's answer.
 *
 * Never throws and never guesses: anything unparsable becomes an `unreachable` failure, because the
 * page's next move for "the host said something I do not understand" is the same as for "the host
 * said nothing" — show it and offer a retry. A malformed ROW is dropped rather than failing the
 * listing, so one bad bank cannot blank the card.
 *
 * @param raw - the parsed JSON body, or whatever the caller managed to read.
 * @returns the listing, or the reason there is none.
 */
export function parseLibrariesResponse(raw: unknown): LibrariesResponse {
  if (!isRecord(raw)) return { ok: false, code: "unreachable", error: "the host sent no answer" };
  if (raw.ok === false) {
    const code = raw.code === "bad-request" || raw.code === "refused" ? raw.code : "unreachable";
    return { ok: false, code, error: typeof raw.error === "string" && raw.error !== "" ? raw.error : code };
  }
  if (raw.ok !== true || !Array.isArray(raw.libraries)) {
    return { ok: false, code: "unreachable", error: "the host sent no libraries" };
  }
  return {
    ok: true,
    endpoint: typeof raw.endpoint === "string" ? raw.endpoint : "",
    serverMode: typeof raw.serverMode === "string" ? raw.serverMode : "",
    disabled: raw.disabled === true,
    all: raw.all === true,
    total: typeof raw.total === "number" ? raw.total : raw.libraries.length,
    hidden: typeof raw.hidden === "number" ? raw.hidden : 0,
    fetchedAt: typeof raw.fetchedAt === "string" ? raw.fetchedAt : "",
    libraries: raw.libraries.map(libraryOf).filter((row): row is LibraryRow => row !== undefined),
  };
}
