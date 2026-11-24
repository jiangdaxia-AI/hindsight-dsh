/**
 * The settings page's library list, and the one action that removes a library.
 *
 * WHY THIS MODULE EXISTS. `inspect.ts` answers the same question for a human reading text, and it is
 * deliberately read-only: nothing there retains, deletes or reconfigures, so the worst a broken
 * report can do is be wrong. The page needs the same listing in a shape a component can render, plus
 * a delete that the report must never grow. Both live here, and the delete is the only mutating call
 * this plugin makes outside the memory runtime.
 *
 * HOW THE PAGE REACHES IT. The settings document is where this plugin's two halves meet for
 * CONFIGURATION, but a list is not configuration: writing a library list into the profile's config
 * file on every refresh would be a lie about what a setting is, and a delete has no sensible
 * spelling as a config write at all. So the host half registers one exact Fetch route on the Host's
 * connection service — the carrier-neutral route registry the web transport always provides — and
 * the browser half calls it under the same origin and the same session cookie as the page itself.
 * That is a request/response channel, which is what a refresh button and a destructive action need.
 *
 * TWO RULES, both inherited from `inspect.ts`:
 *
 *  - FAILURE IS A VALUE. An unreachable server is the situation the page exists for, so it becomes
 *    `{ ok: false, code: "unreachable", error }` and the page renders it. A thrown error here would
 *    be an empty card instead of a diagnosis.
 *  - AN ID ALONE IS NOT AUTHORITY TO DELETE. The delete re-reads the server's own listing and only
 *    removes an id that listing contains, so a typo, a stale row or a hand-made request cannot
 *    remove something the page never showed.
 *
 * Tokens never leave this half: only ids, counts and timestamps are serialized.
 */
import { BANK_PREFIX, CONVERSATION_PREFIX, type InspectTransport } from "./inspect";
import { type LibrariesResponse, type LibraryRow } from "./library-contract";

export { LIBRARY_ROUTE, LIBRARY_CLIENT_ROUTE, parseLibrariesResponse } from "./library-contract";
export type { LibrariesFailure, LibrariesPayload, LibrariesResponse, LibraryRow } from "./library-contract";

/** How many banks are asked for in one pass; the server caps this itself. */
const BANK_LIST_LIMIT = 200;
/** Per-request cap, so a hung server cannot hold the page's refresh open forever. */
const REQUEST_TIMEOUT_MS = 15_000;
/** Session counts asked for at once. Enough to be quick over a LAN, few enough not to flood. */
const COUNT_CONCURRENCY = 4;

/** The read/write slice of the server this module needs. `HindsightClient` satisfies it. */
export type BankTransport = InspectTransport;

/** What the handler needs, resolved at CALL time so a save a second ago is the value in force. */
export interface BankAdminDeps {
  /** The server to talk to, built from the current settings. */
  transport(): BankTransport;
  serverMode(): string;
  disabled(): boolean;
  /** The bank-id prefix that marks a bank as this integration's. Defaults to `coding-agent::`. */
  prefix?: string;
}

/** One bank object, mapped onto a row. Malformed entries are dropped rather than guessed at. */
function rowOf(value: unknown): LibraryRow | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  if (typeof raw.bank_id !== "string" || raw.bank_id === "") return undefined;
  const text = (key: string): string | undefined => (typeof raw[key] === "string" ? (raw[key] as string) : undefined);
  return {
    bankId: raw.bank_id,
    // `name` is what the server displays; `display_alias` is a human label a user set on it, which
    // is more informative than either. `bank_id` is the fallback because it always exists.
    label: text("display_alias") ?? text("name") ?? raw.bank_id,
    factCount: typeof raw.fact_count === "number" ? raw.fact_count : 0,
    sessions: null,
    ...(text("created_at") === undefined ? {} : { createdAt: text("created_at") }),
    ...(text("last_write_at") === undefined ? {} : { lastWriteAt: text("last_write_at") }),
  };
}

/** Newest write first; a bank that was never written sorts last rather than first. */
function byRecency(a: LibraryRow, b: LibraryRow): number {
  return (b.lastWriteAt ?? "").localeCompare(a.lastWriteAt ?? "");
}

/** The banks the page asked for, before the per-bank counts are filled in. */
export interface LibraryListing {
  libraries: LibraryRow[];
  /** Every bank on the server. */
  total: number;
  /** How many the listing left out because they were not this integration's. */
  hidden: number;
}

/**
 * Attach each bank's session count, a few at a time.
 *
 * A count is one request per bank and the list endpoint reports no such number, so this is the N+1
 * the page pays for the column. It is paid here rather than in the component so the browser
 * receives finished rows, and it is TOLERANT: a bank whose count fails keeps `null` instead of
 * failing the whole listing, because "this one number is unknown" must not cost the user the list.
 *
 * @param transport - the server to ask.
 * @param rows - the banks to count, mutated in place.
 */
async function attachCounts(transport: BankTransport, rows: LibraryRow[]): Promise<void> {
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const row = rows[next++];
      if (row === undefined) return;
      try {
        const root = transport.apiUrl.replace(/\/+$/, "");
        const query = new URLSearchParams({ limit: "1", q: CONVERSATION_PREFIX });
        const body = (await (
          await transport.req(
            "GET",
            `${root}/v1/default/banks/${encodeURIComponent(row.bankId)}/documents?${query}`,
            undefined,
            [],
            REQUEST_TIMEOUT_MS,
          )
        ).json()) as { total?: unknown };
        row.sessions = typeof body.total === "number" ? body.total : null;
      } catch {
        row.sessions = null;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(COUNT_CONCURRENCY, rows.length) }, worker));
}

/**
 * Read the server's libraries for the settings page.
 *
 * @param transport - the resolved server.
 * @param options - which libraries to include, and the integration's own bank prefix.
 * @returns the rows, newest write first, with each bank's session count attached.
 */
export async function listLibraries(
  transport: BankTransport,
  options: { all: boolean; prefix?: string },
): Promise<LibraryListing> {
  const prefix = options.prefix ?? BANK_PREFIX;
  const root = transport.apiUrl.replace(/\/+$/, "");
  const body = (await (
    await transport.req("GET", `${root}/v1/default/banks?limit=${BANK_LIST_LIMIT}`, undefined, [], REQUEST_TIMEOUT_MS)
  ).json()) as { banks?: unknown[]; total?: unknown };

  const every = (Array.isArray(body.banks) ? body.banks : [])
    .map(rowOf)
    .filter((row): row is LibraryRow => row !== undefined);
  const mine = every.filter((row) => row.bankId.startsWith(prefix));
  const libraries = (options.all ? every : mine).slice().sort(byRecency);
  await attachCounts(transport, libraries);
  return {
    libraries,
    total: typeof body.total === "number" ? body.total : every.length,
    hidden: options.all ? 0 : every.length - mine.length,
  };
}

/**
 * Send the delete itself.
 *
 * @param transport - the resolved server.
 * @param bankId - an id the server's own listing just confirmed.
 */
async function deleteBank(transport: BankTransport, bankId: string): Promise<void> {
  const root = transport.apiUrl.replace(/\/+$/, "");
  await transport.req(
    "DELETE",
    `${root}/v1/default/banks/${encodeURIComponent(bankId)}`,
    undefined,
    [],
    REQUEST_TIMEOUT_MS,
  );
}

/**
 * Remove one library, permanently.
 *
 * The id is checked against the server's own listing first: a request naming a bank that is not
 * there (a stale row, a typo, a hand-made call) is refused rather than passed through, so this can
 * only ever remove something the page was showing.
 *
 * @param transport - the resolved server.
 * @param bankId - the bank to remove.
 * @param all - whether the listing this id came from included banks of every origin.
 * @throws when the bank is absent from that listing.
 */
export async function removeLibrary(transport: BankTransport, bankId: string, all: boolean): Promise<void> {
  const listed = await listLibraries(transport, { all });
  if (!listed.libraries.some((row) => row.bankId === bankId)) {
    throw new Error(`no such bank on this server: ${bankId}`);
  }
  await deleteBank(transport, bankId);
}

/** The JSON response every branch of the route returns. */
function json(body: LibrariesResponse, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });
}

/** One line describing why a call failed, without ever quoting a credential. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The listing, as the page reads it, including the facts about the server it came from. */
function payloadOf(
  deps: BankAdminDeps,
  transport: BankTransport,
  listing: LibraryListing,
  all: boolean,
): LibrariesResponse {
  return {
    ok: true,
    endpoint: transport.apiUrl,
    serverMode: deps.serverMode(),
    disabled: deps.disabled(),
    all,
    total: listing.total,
    hidden: listing.hidden,
    fetchedAt: new Date().toISOString(),
    libraries: listing.libraries,
  };
}

/**
 * Answer one request from the settings page.
 *
 * `GET` lists; `POST` removes. Both answer `200` with a JSON body, INCLUDING failures, because the
 * page's only job on a failure is to say what went wrong — an HTTP status would make the browser's
 * fetch reject and lose the reason before the component could render it. The two exceptions are the
 * request-level refusals the page must not mistake for a server problem: a malformed body is a 400,
 * a delete guard rejection is a 404, and an unknown method is a 405.
 *
 * @param request - the Fetch request the connection service routed here.
 * @param deps - the currently resolved server and settings.
 * @returns the page's answer.
 */
export async function handleLibraryRequest(request: Request, deps: BankAdminDeps): Promise<Response> {
  const prefix = deps.prefix ?? BANK_PREFIX;
  const wantsAll = new URL(request.url).searchParams.get("all") === "1";

  try {
    const transport = deps.transport();

    if (request.method === "GET") {
      return json(payloadOf(deps, transport, await listLibraries(transport, { all: wantsAll, prefix }), wantsAll));
    }

    if (request.method === "POST") {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return json({ ok: false, code: "bad-request", error: "the request body is not JSON" }, 400);
      }
      const payload = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
      if (payload.action !== "delete" || typeof payload.bankId !== "string" || payload.bankId === "") {
        return json({ ok: false, code: "bad-request", error: 'expected {"action":"delete","bankId":…}' }, 400);
      }
      const all = wantsAll || payload.all === true;
      try {
        await removeLibrary(transport, payload.bankId, all);
      } catch (error) {
        // The guard refused it: the id is not one the server is showing. Answering with the request
        // status rather than "unreachable" keeps the page from blaming the network for a stale row.
        return json({ ok: false, code: "refused", error: reasonOf(error) }, 404);
      }
      // The answer to a delete is the state AFTER it, so the page repaints from one round trip
      // instead of firing a second refresh that could fail on its own.
      return json(payloadOf(deps, transport, await listLibraries(transport, { all, prefix }), all));
    }

    return json({ ok: false, code: "bad-request", error: `unsupported method ${request.method}` }, 405);
  } catch (error) {
    return json({ ok: false, code: "unreachable", error: reasonOf(error) });
  }
}
