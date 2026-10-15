/**
 * What the plugin already recorded, and whether this session's memory is working.
 *
 * Memory is otherwise invisible from the outside: the plugin writes to a bank on a server, and the
 * only ways to see what landed were the agent's own `hindsight_*` tools (the model has to ask) and
 * hand-written curl. This module answers the two questions a user asks while debugging — "which
 * projects have been recorded?" and "is the memory here actually on?" — from the same server the
 * plugin talks to, plus the logs it writes.
 *
 * Two rules hold everywhere:
 *
 * - READ-ONLY. Nothing here retains, deletes or reconfigures; the worst a call can do is a GET.
 * - FAILURE-TOLERANT. One unreachable endpoint must not blank the report: a failed lookup becomes
 *   `—` and the rest still prints. The one situation the report is needed in is the one where
 *   something is broken, so "the server did not answer" has to be a line in the output, not an
 *   exception thrown instead of it.
 *
 * Tokens are never printed; the endpoint is named, the credential is not.
 */
import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { CONFIG_PATH, type Config } from "../vendor/coding-agents/src/core/config";
import { diagFilePath } from "../vendor/coding-agents/src/core/diag";
import { logFilePath, logsDir } from "../vendor/coding-agents/src/core/log";
import type { SyncStatus } from "../vendor/coding-agents/src/core/status";
import { usageFilePath } from "../vendor/coding-agents/src/core/usage";

/** One request's hard cap, so an inspection can never hang the UI or the shell that asked. */
const REQUEST_TIMEOUT_MS = 10_000;
/** Banks asked for in one pass; the server caps this itself, it is only a sane number to name. */
const BANK_LIST_LIMIT = 200;
/** Bytes read from the tail of a rotated log — enough for the last bind and the last error. */
const LOG_TAIL_BYTES = 256 * 1024;
/** Operation statuses that are DONE, so "active" counts only what is still running. */
const TERMINAL_OPERATIONS = new Set(["completed", "failed", "cancelled", "error"]);
/** Every bank this integration creates starts with this, so the listing can default to "mine". */
const BANK_PREFIX = "coding-agent::";
/** Documents listed when neither the command nor the CLI says how many. */
const DEFAULT_DOCUMENT_LIMIT = 20;
/** Ceiling on `--limit`: a report nobody can read is not a report, and the server caps nothing. */
const MAX_DOCUMENT_LIMIT = 500;

const HELP_TEXT = `hindsight — this project's memory

  /hindsight                          what this repository has recorded, and whether memory is working
  /hindsight banks [--all]            every bank on the server (--all includes ones this integration did not create)
  /hindsight bank <bank_id>           one bank in detail: documents, knowledge pages, running extractions
  /hindsight documents <bank_id>      the documents themselves, newest write first
  /hindsight doctor                   plugin self-check: bind line, daemon, config, logs
  /hindsight help                     this text

  documents flags: --limit <n> (default ${DEFAULT_DOCUMENT_LIMIT}, max ${MAX_DOCUMENT_LIMIT})
                   --tags <a,b>  only documents carrying ALL of them
                   --q <text>    substring of the document id

The same reports are available from a shell:

  hindsight-dsh [status|banks|bank <bank_id>|documents <bank_id>|doctor]
                [--all] [--limit <n>] [--tags <a,b>] [--q <text>] [--cwd <dir>] [--json]`;

export { HELP_TEXT };

/** A row of the bank listing, as the list endpoint already reports it: no extra request needed. */
export interface BankRow {
  bankId: string;
  factCount: number;
  createdAt?: string;
  lastWriteAt?: string;
  mission?: string;
}

export interface BanksResponse {
  total: number;
  banks: BankRow[];
}

export interface BankDetail extends BankRow {
  documents: number;
  pages: string[];
  /** Running extractions; `null` when the server could not be asked. */
  activeOps: number | null;
}

/** One document as the listing reports it: the identity, when it last moved, and its provenance. */
export interface DocumentRow {
  id: string;
  updatedAt?: string;
  createdAt?: string;
  tags: string[];
}

/** What documents to ask for. Every field is optional; the server's own defaults are sane. */
export interface DocumentQuery {
  limit?: number;
  tags?: string[];
  q?: string;
}

export interface DocumentsResponse {
  /** Rows matching the filter — not the bank's size, which is what `documentCount` reports. */
  total: number;
  items: DocumentRow[];
}

/** The read-only slice of the server this module needs. */
export interface InspectApi {
  banks(): Promise<BanksResponse>;
  /** How many documents the bank holds, for the summary lines. */
  documentCount(bankId: string): Promise<number>;
  documents(bankId: string, query?: DocumentQuery): Promise<DocumentsResponse>;
  pages(bankId: string): Promise<string[]>;
  activeOperations(bankId: string): Promise<number | null>;
  health(): Promise<boolean>;
}

/**
 * The slice of `HindsightClient` this module uses.
 *
 * Structural rather than a client import, so the reports are testable against a stub and this
 * module stays free of the whole memory runtime's types. `HindsightClient` satisfies it as it is,
 * which is what keeps authentication, 401 token refresh, retries and the request timeout in ONE
 * place instead of reimplemented here.
 */
export interface InspectTransport {
  readonly apiUrl: string;
  req(method: string, url: string, body?: unknown, tolerate?: number[], timeoutMs?: number): Promise<Response>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Map one bank object from the API onto the report's row, dropping anything malformed. */
function rowOf(value: unknown): BankRow | undefined {
  if (!isRecord(value) || typeof value.bank_id !== "string" || value.bank_id === "") return undefined;
  const number = (key: string): number => (typeof value[key] === "number" ? (value[key] as number) : 0);
  const text = (key: string): string | undefined => (typeof value[key] === "string" ? (value[key] as string) : undefined);
  return {
    bankId: value.bank_id,
    factCount: number("fact_count"),
    createdAt: text("created_at"),
    lastWriteAt: text("last_write_at"),
    mission: text("mission"),
  };
}

/** Map one document object from the API onto the report's row, dropping anything malformed. */
function documentOf(value: unknown): DocumentRow | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || value.id === "") return undefined;
  const tags = Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [];
  return {
    id: value.id,
    updatedAt: typeof value.updated_at === "string" ? value.updated_at : undefined,
    createdAt: typeof value.created_at === "string" ? value.created_at : undefined,
    tags,
  };
}

/** Build the API over anything that can make an authenticated request. */
export function createInspectApi(transport: InspectTransport): InspectApi {
  const root = transport.apiUrl.replace(/\/+$/, "");
  const bankUrl = (bankId: string, suffix = ""): string =>
    `${root}/v1/default/banks/${encodeURIComponent(bankId)}${suffix}`;
  const json = async <T>(url: string): Promise<T> =>
    (await transport.req("GET", url, undefined, [], REQUEST_TIMEOUT_MS)).json() as Promise<T>;

  return {
    async banks(): Promise<BanksResponse> {
      const body = await json<{ banks?: unknown[]; total?: unknown }>(`${root}/v1/default/banks?limit=${BANK_LIST_LIMIT}`);
      const banks = (Array.isArray(body.banks) ? body.banks : [])
        .map(rowOf)
        .filter((row): row is BankRow => row !== undefined);
      return { total: typeof body.total === "number" ? body.total : banks.length, banks };
    },

    async documentCount(bankId: string): Promise<number> {
      // One document per pass, for the total the list endpoint does not report.
      const body = await json<{ total?: unknown }>(bankUrl(bankId, "/documents?limit=1"));
      return typeof body.total === "number" ? body.total : 0;
    },

    async documents(bankId: string, query: DocumentQuery = {}): Promise<DocumentsResponse> {
      // `tags` is a REPEATED query key, not a comma-separated one: the server parses it as a list,
      // and a joined value is looked up as a single literal tag — which matches nothing, silently.
      const params = new URLSearchParams({ limit: String(query.limit ?? DEFAULT_DOCUMENT_LIMIT) });
      const tags = query.tags ?? [];
      for (const tag of tags) params.append("tags", tag);
      // Every named tag must be present: a filter whose tags are ORed answers a different question
      // than the one asked, and the bank already carries provenance tags an OR would blur.
      if (tags.length > 0) params.set("tags_match", "all_strict");
      if (query.q) params.set("q", query.q);
      const body = await json<{ items?: unknown[]; total?: unknown }>(bankUrl(bankId, `/documents?${params}`));
      const items = (Array.isArray(body.items) ? body.items : [])
        .map(documentOf)
        .filter((row): row is DocumentRow => row !== undefined);
      return { total: typeof body.total === "number" ? body.total : items.length, items };
    },

    async pages(bankId: string): Promise<string[]> {
      const body = await json<{ roots?: unknown[] }>(bankUrl(bankId, "/knowledge-base/tree"));
      return (Array.isArray(body.roots) ? body.roots : [])
        .filter((node) => isRecord(node) && node.kind === "page")
        .map((node) => (isRecord(node) && typeof node.name === "string" ? node.name : ""))
        .filter((name) => name !== "");
    },

    async activeOperations(bankId: string): Promise<number | null> {
      const body = await json<{ operations?: unknown[]; items?: unknown[] }>(bankUrl(bankId, "/operations"));
      const ops = [
        ...(Array.isArray(body.operations) ? body.operations : []),
        ...(Array.isArray(body.items) ? body.items : []),
      ];
      return ops.filter((op) => {
        const status = isRecord(op) && typeof op.status === "string" ? op.status.toLowerCase() : "";
        return status !== "" && !TERMINAL_OPERATIONS.has(status);
      }).length;
    },

    async health(): Promise<boolean> {
      try {
        const body = await json<{ status?: unknown }>(`${root}/health`);
        return body.status === "healthy";
      } catch {
        return false;
      }
    },
  };
}

/** Everything a report is built from. */
export interface InspectDeps {
  api: InspectApi;
  /** The resolved memory config (endpoint, mode, bank template) — never its token. */
  cfg: Config;
  /** The directory this report is about: a session's cwd, or `--cwd`. */
  directory: string;
  /** The bank `directory` resolves to; `""` when memory is off there (disabled or opted out). */
  bankId: string;
  /** `hindsight_sync_status` for `directory`; absent when no bank resolved. */
  sync?(): Promise<SyncStatus>;
  /** Files the reports read. Injectable so a test never touches the real config or logs. */
  files?: { plugin: string; diag: string; usage: string; config?: string };
}

export type InspectRequest =
  | { kind: "overview" }
  | { kind: "banks"; all: boolean }
  | { kind: "bank"; bankId: string }
  | { kind: "documents"; bankId: string; limit: number; tags: string[]; q?: string }
  | { kind: "doctor" }
  | { kind: "help" }
  | { kind: "invalid"; word: string };

/**
 * Read the arguments of `/hindsight`, or of the CLI's positional words.
 *
 * The grammar is the command's own (cordis hands the raw text after the name), so it is parsed here
 * once and shared with the shell entry point — one behaviour, two front doors.
 */
export function parseInspectInput(raw: string): InspectRequest {
  const words = raw.trim().split(/\s+/).filter((word) => word !== "");
  if (words.length === 0) return { kind: "overview" };
  const [head, second, ...rest] = words;

  if (head === "help" || head === "--help" || head === "-h") return { kind: "help" };
  if (head === "banks") {
    if (second === undefined) return { kind: "banks", all: false };
    if (second === "--all") return { kind: "banks", all: true };
    return { kind: "invalid", word: second };
  }
  if (head === "bank") {
    if (second === undefined || rest.length > 0) return { kind: "invalid", word: words.slice(1).join(" ") };
    return { kind: "bank", bankId: second };
  }
  if (head === "documents") {
    if (second === undefined) return { kind: "invalid", word: "" };
    // The flags come AFTER the bank id, and a bank id is one word even though it contains `::`.
    let limit = DEFAULT_DOCUMENT_LIMIT;
    let tags: string[] = [];
    let q: string | undefined;
    for (let i = 2; i < words.length; i++) {
      const word: string | undefined = words[i];
      if (word === "--limit") {
        const value: string | undefined = words[++i];
        const parsed = value === undefined ? Number.NaN : Number(value);
        if (!Number.isInteger(parsed) || parsed < 1) return { kind: "invalid", word: value ?? "--limit" };
        limit = Math.min(parsed, MAX_DOCUMENT_LIMIT);
      } else if (word === "--tags") {
        const value: string | undefined = words[++i];
        if (value === undefined) return { kind: "invalid", word: "--tags" };
        tags = value
          .split(",")
          .map((tag) => tag.trim())
          .filter((tag) => tag !== "");
        if (tags.length === 0) return { kind: "invalid", word: value };
      } else if (word === "--q") {
        const value: string | undefined = words[++i];
        if (value === undefined) return { kind: "invalid", word: "--q" };
        q = value;
      } else {
        return { kind: "invalid", word: word ?? "" };
      }
    }
    return { kind: "documents", bankId: second, limit, tags, ...(q === undefined ? {} : { q }) };
  }
  if (head === "doctor") return { kind: "doctor" };
  return { kind: "invalid", word: words.join(" ") };
}

export interface Overview {
  apiUrl: string;
  serverMode: Config["serverMode"];
  disabled: boolean;
  daemonHealthy: boolean;
  directory: string;
  bankId: string;
  records: { facts: number; documents: number; pages: number; lastWriteAt?: string } | null;
  sync: SyncStatus | null;
  projects: { total: number; mine: number } | null;
  configFile: string;
  logsDir: string;
}

export interface BanksReport {
  total: number;
  /** Rows this report shows, newest write first. */
  shown: BankRow[];
  /** How many banks `--all` would add. */
  hidden: number;
}

export interface DoctorReport {
  configFile: string;
  configPresent: boolean;
  plugin: { serverMode: Config["serverMode"]; apiUrl: string; disabled: boolean; hostOverrides: boolean };
  daemonHealthy: boolean;
  /** The last bind line, or the last bind FAILURE — the one thing this report exists to surface. */
  bind: { at?: string; error?: string; logBytes?: number } | null;
  diag: { at?: string; event?: string } | null;
  usage: { at?: string; bank?: string } | null;
  files: { plugin: string; diag: string; usage: string };
  banks: { total: number; mine: number } | null;
}

/** The log files a report reads, defaulting to the ones this harness writes. */
function logFiles(deps: InspectDeps): { plugin: string; diag: string; usage: string } {
  return (
    deps.files ?? {
      plugin: logFilePath(),
      diag: diagFilePath(),
      usage: usageFilePath(),
    }
  );
}

/** THE config file this install reads, unless a test names another. */
function configFileOf(deps: InspectDeps): string {
  return deps.files?.config ?? CONFIG_PATH;
}

/** Read at most `maxBytes` from the END of a file; undefined when it cannot be read. */
function readTail(path: string, maxBytes = LOG_TAIL_BYTES): string | undefined {
  try {
    const { size } = statSync(path);
    const length = Math.min(maxBytes, size);
    if (length === 0) return "";
    const fd = openSync(path, "r");
    try {
      const buffer = Buffer.alloc(length);
      readSync(fd, buffer, 0, length, size - length);
      return buffer.toString("utf8");
    } finally {
      closeSync(fd);
    }
  } catch {
    return undefined;
  }
}

/** The last line containing `needle`, or undefined. */
function lastLineWith(text: string | undefined, needle: string): string | undefined {
  if (!text) return undefined;
  const lines = text.split("\n").filter((line) => line.includes(needle));
  return lines.at(-1);
}

/** The `ts` of the last parseable JSON line, with one field from it. */
function lastJsonField(text: string | undefined, field: string): { at?: string; value?: string } | null {
  if (!text) return null;
  const lines = text.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line === undefined || line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!isRecord(parsed)) continue;
      return {
        at: typeof parsed.ts === "string" ? parsed.ts : undefined,
        value: typeof parsed[field] === "string" ? (parsed[field] as string) : undefined,
      };
    } catch {
      /* a half-written line at the tail is normal; keep walking back */
    }
  }
  return null;
}

/** `2026-10-14T07:01:44.123Z` → `2026-10-14 15:01` in the reader's own timezone. */
function stamp(iso?: string): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** `1400` → `1400`, `124656` → `122 KB`. */
function bytes(n?: number): string {
  if (n === undefined) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pad every column but the last, so a copied line still lines up. */
function columns(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const row of rows) row.forEach((cell, i) => (widths[i] = Math.max(widths[i] ?? 0, cell.length)));
  return rows.map((row) =>
    row.map((cell, i) => (i === row.length - 1 ? cell : cell.padEnd(widths[i] ?? 0))).join("  ").trimEnd(),
  );
}

/** Trim one line of prose to something a report can show. */
function oneLine(text: string | undefined, max = 100): string {
  if (!text) return "—";
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

async function collectRecords(
  deps: InspectDeps,
  listed: BanksResponse | null,
): Promise<Overview["records"]> {
  const row = listed?.banks.find((bank) => bank.bankId === deps.bankId);
  const [documents, pages] = await Promise.all([
    deps.api.documentCount(deps.bankId).catch(() => null),
    deps.api.pages(deps.bankId).catch(() => null),
  ]);
  return {
    facts: row?.factCount ?? 0,
    lastWriteAt: row?.lastWriteAt,
    documents: documents ?? 0,
    pages: pages?.length ?? 0,
  };
}

export async function collectOverview(deps: InspectDeps): Promise<Overview> {
  const [daemonHealthy, listed] = await Promise.all([
    deps.api.health().catch(() => false),
    deps.api.banks().catch(() => null),
  ]);
  const [records, sync] = await Promise.all([
    deps.bankId !== "" ? collectRecords(deps, listed) : Promise.resolve(null),
    deps.sync
      ? deps.sync().then(
          (value) => value,
          () => null,
        )
      : Promise.resolve(null),
  ]);
  return {
    apiUrl: deps.cfg.apiUrl,
    serverMode: deps.cfg.serverMode,
    disabled: deps.cfg.disabled,
    daemonHealthy,
    directory: deps.directory,
    bankId: deps.bankId,
    records,
    sync,
    projects: listed
      ? { total: listed.total, mine: listed.banks.filter((bank) => bank.bankId.startsWith(BANK_PREFIX)).length }
      : null,
    configFile: configFileOf(deps),
    logsDir: logsDir(),
  };
}

export async function collectBanks(deps: InspectDeps, all = false): Promise<BanksReport> {
  const listed = await deps.api.banks();
  const mine = listed.banks.filter((bank) => bank.bankId.startsWith(BANK_PREFIX));
  const shown = (all ? listed.banks : mine)
    .slice()
    .sort((a, b) => (b.lastWriteAt ?? "").localeCompare(a.lastWriteAt ?? ""));
  return { total: listed.total, shown, hidden: all ? 0 : listed.banks.length - mine.length };
}

export async function collectBank(deps: InspectDeps, bankId: string): Promise<BankDetail> {
  const listed = await deps.api.banks().catch(() => null);
  const row = listed?.banks.find((bank) => bank.bankId === bankId);
  const [documents, pages, activeOps] = await Promise.all([
    deps.api.documentCount(bankId).catch(() => null),
    deps.api.pages(bankId).catch(() => null),
    deps.api.activeOperations(bankId).catch(() => null),
  ]);
  return {
    bankId,
    factCount: row?.factCount ?? 0,
    createdAt: row?.createdAt,
    lastWriteAt: row?.lastWriteAt,
    mission: row?.mission,
    documents: documents ?? 0,
    pages: pages ?? [],
    activeOps,
  };
}

/** One listing of a bank's documents, with the filter that produced it kept for the header. */
export interface DocumentsReport {
  bankId: string;
  /** Rows matching the filter on the server — not the bank's size. */
  total: number;
  shown: DocumentRow[];
  limit: number;
  tags: string[];
  q?: string;
}

export async function collectDocuments(
  deps: InspectDeps,
  request: { bankId: string; limit: number; tags: string[]; q?: string },
): Promise<DocumentsReport> {
  const { total, items } = await deps.api.documents(request.bankId, {
    limit: request.limit,
    tags: request.tags,
    ...(request.q === undefined ? {} : { q: request.q }),
  });
  return {
    bankId: request.bankId,
    total,
    shown: items,
    limit: request.limit,
    tags: request.tags,
    ...(request.q === undefined ? {} : { q: request.q }),
  };
}

export async function collectDoctor(deps: InspectDeps): Promise<DoctorReport> {
  const files = logFiles(deps);
  const pluginText = readTail(files.plugin);
  const bindLine = lastLineWith(pluginText, "memory plugin bound");
  const failureLine = lastLineWith(pluginText, "the plugin failed to bind");
  let logBytes: number | undefined;
  try {
    logBytes = statSync(files.plugin).size;
  } catch {
    logBytes = undefined;
  }
  const diag = lastJsonField(readTail(files.diag), "event");
  const usage = lastJsonField(readTail(files.usage), "bank");
  const listed = await deps.api.banks().catch(() => null);
  return {
    configFile: configFileOf(deps),
    configPresent: existsSync(configFileOf(deps)),
    plugin: {
      serverMode: deps.cfg.serverMode,
      apiUrl: deps.cfg.apiUrl,
      disabled: deps.cfg.disabled,
      hostOverrides: (process.env.HINDSIGHT_HOST_OVERRIDES ?? "").trim() !== "",
    },
    daemonHealthy: await deps.api.health().catch(() => false),
    bind: failureLine
      ? { error: oneLine(failureLine.split("failed to bind:").at(-1), 160), logBytes }
      : bindLine
        ? { at: bindLine.match(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/)?.[0], logBytes }
        : { logBytes },
    diag: diag ? { at: diag.at, event: diag.value } : null,
    usage: usage ? { at: usage.at, bank: usage.value } : null,
    files,
    banks: listed
      ? { total: listed.total, mine: listed.banks.filter((bank) => bank.bankId.startsWith(BANK_PREFIX)).length }
      : null,
  };
}

/** One line of `hindsight_sync_status`, for the overview. */
function syncLine(sync: SyncStatus): string {
  const deepen = sync.gitDiffTarget === null ? `${sync.gitDiffDocs}` : `${sync.gitDiffDocs}/${sync.gitDiffTarget}`;
  const survey =
    sync.surveyBaseline === null
      ? "survey none"
      : `survey ${sync.surveyCommitsBehind === null ? sync.surveyDocs : `${sync.surveyCommitsBehind} behind`}`;
  return [
    sync.synced ? "synced" : "not synced yet",
    `gitlog ${sync.gitlogPresent ? "yes" : "no"}`,
    `deepen ${deepen}`,
    `chats ${sync.chatDocs}`,
    `pages ${sync.pagesCount}`,
    survey,
    `ops ${sync.activeOps === null ? "—" : sync.activeOps}`,
  ].join(" · ");
}

export function formatBanks(report: BanksReport, all: boolean): string {
  const head = all
    ? `Hindsight banks · all ${report.shown.length} of ${report.total}`
    : `Hindsight banks · ${report.shown.length} created by this integration (of ${report.total})`;
  if (report.shown.length === 0) {
    return `${head}\nno banks yet — open a repository with the plugin installed and its first session seeds one`;
  }
  const rows: string[][] = [["BANK", "FACTS", "CREATED", "LAST WRITE"]];
  for (const bank of report.shown) {
    rows.push([bank.bankId, String(bank.factCount), stamp(bank.createdAt), stamp(bank.lastWriteAt)]);
  }
  const tail =
    report.hidden > 0 ? `\n${report.hidden} more bank(s) not created by this integration — add --all` : "";
  return [head, "", ...columns(rows), tail].join("\n").trimEnd();
}

export function formatOverview(overview: Overview): string {
  const lines = ["hindsight · dsh memory"];
  const endpoint = overview.disabled
    ? "memory is OFF for this directory"
    : `${overview.serverMode} · ${overview.apiUrl}`;
  lines.push(`  plugin    ${endpoint}${overview.daemonHealthy ? " · daemon healthy" : " · daemon NOT answering"}`);
  const target = overview.bankId === "" ? "(no bank — disabled or opted out here)" : overview.bankId;
  lines.push(`  repo      ${overview.directory} → ${target}`);
  if (overview.records) {
    const sync = overview.sync;
    lines.push(
      `  records   ${overview.records.facts} facts · ${overview.records.documents} documents · ` +
        `${overview.records.pages} knowledge pages · last write ${stamp(overview.records.lastWriteAt)}`,
    );
    if (sync) lines.push(`  sync      ${syncLine(sync)}`);
    else lines.push(`  sync      — (nothing answered; the session has not seeded this bank yet?)`);
  } else {
    lines.push(`  records   — memory is off for this directory`);
  }
  lines.push(
    overview.projects
      ? `  projects  ${overview.projects.mine} bank(s) from this integration, ${overview.projects.total} total — /hindsight banks`
      : `  projects  — (the server did not answer)`,
  );
  lines.push(`  config    ${overview.configFile}`);
  lines.push(`  logs      ${overview.logsDir}`);
  return lines.join("\n");
}

export function formatBank(bank: BankDetail): string {
  const lines = [
    `bank       ${bank.bankId}`,
    `created    ${stamp(bank.createdAt)}`,
    `written    ${stamp(bank.lastWriteAt)}   (${bank.factCount} facts)`,
    `documents  ${bank.documents}`,
    `operations ${bank.activeOps === null ? "— (the server did not answer)" : `${bank.activeOps} still running`}`,
  ];
  if (bank.pages.length === 0) lines.push(`pages      none yet`);
  else {
    const names = bank.pages.slice(0, 6).join(", ");
    lines.push(`pages      ${bank.pages.length} — ${names}${bank.pages.length > 6 ? ", …" : ""}`);
  }
  if (bank.mission) lines.push(`mission    ${oneLine(bank.mission, 160)}`);
  return lines.join("\n");
}

export function formatDocuments(report: DocumentsReport): string {
  const filters = [
    report.tags.length > 0 ? `tags ${report.tags.join(" + ")} (all)` : undefined,
    report.q === undefined ? undefined : `q "${report.q}"`,
  ].filter((part): part is string => part !== undefined);
  const head = `Hindsight documents · ${report.bankId}${filters.length > 0 ? ` · ${filters.join(" · ")}` : ""}`;
  if (report.shown.length === 0) {
    return `${head}\nno documents match — nothing in this bank carries those filters`;
  }
  const rows: string[][] = [["UPDATED", "DOCUMENT", "TAGS"]];
  for (const document of report.shown) {
    rows.push([stamp(document.updatedAt), document.id, document.tags.join(" ") || "—"]);
  }
  const more =
    report.total > report.shown.length
      ? `\nshowing ${report.shown.length} of ${report.total} — raise --limit (max ${MAX_DOCUMENT_LIMIT})`
      : "";
  return [head, "", ...columns(rows), more].join("\n").trimEnd();
}

export function formatDoctor(report: DoctorReport): string {
  const files = report.files;
  const bind = report.bind?.error
    ? `FAILED — ${report.bind.error}  (see ${files.plugin}; restart dsh after a rebuild)`
    : report.bind?.at
      ? `last "memory plugin bound" ${stamp(report.bind.at)} · plugin.log ${bytes(report.bind.logBytes)}`
      : `NO "memory plugin bound" in ${files.plugin} — this plugin is not binding`;
  return [
    "hindsight doctor",
    `  config    ${report.configFile} (${report.configPresent ? "present" : "absent — defaults + environment"})`,
    `  plugin    ${report.plugin.disabled ? "disabled" : report.plugin.serverMode} · ${report.plugin.apiUrl}` +
      `${report.plugin.hostOverrides ? " · host overrides published" : ""}`,
    `  daemon    ${report.daemonHealthy ? "healthy" : "NOT answering"}`,
    `  bind      ${bind}`,
    `  diag      ${report.diag ? `last event ${report.diag.event ?? "?"} at ${stamp(report.diag.at)}` : "no events"}`,
    `  usage     ${report.usage ? `last turn ${stamp(report.usage.at)} in ${report.usage.bank ?? "?"}` : "no turns recorded"}`,
    `  banks     ${report.banks ? `${report.banks.mine} from this integration (${report.banks.total} total)` : "— (the server did not answer)"}`,
    `  logs      ${files.plugin} · ${files.diag} · ${files.usage}`,
  ].join("\n");
}

export type InspectData =
  | { kind: "overview"; overview: Overview }
  | { kind: "banks"; banks: BanksReport; all: boolean }
  | { kind: "bank"; bank: BankDetail }
  | { kind: "documents"; documents: DocumentsReport }
  | { kind: "doctor"; doctor: DoctorReport };

/**
 * Gather one report. Returns `null` for the requests that carry no data (help, a bad argument) —
 * the callers print the usage text for those.
 */
export async function collectInspect(deps: InspectDeps, request: InspectRequest): Promise<InspectData | null> {
  switch (request.kind) {
    case "overview":
      return { kind: "overview", overview: await collectOverview(deps) };
    case "banks":
      return { kind: "banks", banks: await collectBanks(deps, request.all), all: request.all };
    case "bank":
      return { kind: "bank", bank: await collectBank(deps, request.bankId) };
    case "documents":
      return { kind: "documents", documents: await collectDocuments(deps, request) };
    case "doctor":
      return { kind: "doctor", doctor: await collectDoctor(deps) };
    default:
      return null;
  }
}

/** Render collected data as the text both front doors show. */
export function formatInspect(data: InspectData): string {
  switch (data.kind) {
    case "overview":
      return formatOverview(data.overview);
    case "banks":
      return formatBanks(data.banks, data.all);
    case "bank":
      return formatBank(data.bank);
    case "documents":
      return formatDocuments(data.documents);
    case "doctor":
      return formatDoctor(data.doctor);
  }
}

/** Collect and render in one step, for callers that only want the text. */
export async function runInspect(deps: InspectDeps, request: InspectRequest): Promise<string> {
  const data = await collectInspect(deps, request);
  return data === null ? HELP_TEXT : formatInspect(data);
}
