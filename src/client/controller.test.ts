import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsOp, SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-primitives";
import { HindsightCardController, SETUP_ANSWER_TIMEOUT_MS } from "./controller";
import { DEFAULT_SETTINGS, NAMESPACE, SECRET_FIELD } from "../fields";
import { serializeSetupStatus } from "../setup-types";

/** An in-memory stand-in for the shared settings form the browser would talk to the Host with. */
class FakeScope implements SettingsScope {
  readonly writes: SettingsOp[][] = [];
  value: Record<string, unknown>;
  user: Record<string, unknown> = {};
  writable = true;
  status: SettingsScopeSnapshot["status"] = "ready";
  revision = 1;
  private readonly listeners = new Set<() => void>();

  constructor(value: Record<string, unknown> = {}) {
    this.value = { ...DEFAULT_SETTINGS, ...value };
  }

  getSnapshot(): SettingsScopeSnapshot {
    return {
      status: this.status,
      value: this.value,
      base: { ...DEFAULT_SETTINGS },
      user: this.user,
      revision: this.revision,
      writable: this.writable,
      mode: "host",
    };
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async set(field: string, value: unknown): Promise<boolean> {
    return this.mutate([{ op: "set", path: [field], value }]);
  }

  async unset(field: string): Promise<boolean> {
    return this.mutate([{ op: "unset", path: [field] }]);
  }

  async mutate(ops: SettingsOp[]): Promise<boolean> {
    this.writes.push(ops);
    for (const op of ops) {
      if (op.op === "set" && op.path.length === 1) this.value[op.path[0]!] = op.value;
      if (op.op === "unset" && op.path.length === 1) delete this.value[op.path[0]!];
    }
    this.revision += 1;
    for (const listener of [...this.listeners]) listener();
    return true;
  }
}

/** A describe mirror carrying the secret presence markers the Host redacts values into. */
function mirror(secrets?: Array<{ path: unknown; set: unknown }>) {
  const listeners = new Set<() => void>();
  const view = { namespaces: [{ ns: NAMESPACE, ...(secrets ? { secrets } : {}) }] };
  return {
    getSnapshot: () => ({ view }),
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

function controllerFor(scope: FakeScope, description = mirror([{ path: [SECRET_FIELD], set: true }])) {
  const card = new HindsightCardController(scope, { configForms: { get: () => scope, describe: () => description } } as never);
  return { card, face: card.inject() };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("settings page controller", () => {
  it("projects the effective values, so the page shows what the runtime would use", () => {
    const scope = new FakeScope({ serverMode: "self-hosted", apiUrl: "http://localhost:8888", retainSessions: false });
    const { face } = controllerFor(scope);
    const state = face.hooks.hindsightCard.getSnapshot();
    expect(state.serverMode).toBe("self-hosted");
    expect(state.apiUrl.text).toBe("http://localhost:8888");
    expect(state.retainSessions).toBe(false);
    expect(state.available).toBe(true);
    expect(state.dirty).toBe(false);
  });

  it("counts a staged switch as dirty, which is what enables Save", () => {
    const scope = new FakeScope();
    const { card, face } = controllerFor(scope);
    card.stage("serverMode", "cloud");
    expect(face.hooks.hindsightCard.getSnapshot().dirty).toBe(true);
  });

  it("writes staged switches first, as one mutation, then the form's own fields", async () => {
    const scope = new FakeScope();
    const { card, face } = controllerFor(scope);
    card.stage("serverMode", "self-hosted");
    face.edit("apiUrl", "http://localhost:9999");
    await face.save();
    // The first save adopts the page (see toRuntimeConfig) inside the same mutation as the switches.
    expect(scope.writes[0]).toEqual([
      { op: "set", path: ["adopted"], value: true },
      { op: "set", path: ["serverMode"], value: "self-hosted" },
    ]);
    expect(scope.writes[1]).toEqual([{ op: "set", path: ["apiUrl"], value: "http://localhost:9999" }]);
    // Both halves clear on success, so Save goes inert again.
    expect(face.hooks.hindsightCard.getSnapshot().dirty).toBe(false);
    expect(scope.value.serverMode).toBe("self-hosted");
    expect(scope.value.apiUrl).toBe("http://localhost:9999");
    // Adoption is once: a later save writes no marker again.
    const writesBefore = scope.writes.length;
    card.stage("logLevel", "debug");
    await face.save();
    expect(scope.writes[writesBefore]).toEqual([{ op: "set", path: ["logLevel"], value: "debug" }]);
  });

  it("never writes a blank token, leaving the stored one in place", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    await face.save();
    expect(scope.writes).toEqual([]);
    face.edit(SECRET_FIELD, "   ");
    await face.save();
    expect(scope.writes).toEqual([]);
  });

  it("saving the model pick asks for the setup that applies it — in daemon mode, once, silently", async () => {
    const scope = new FakeScope({ serverMode: "daemon", llmChoice: "" });
    const { card, face } = controllerFor(scope);
    card.stage("llmChoice", "token::glm-5.3-flash");
    await face.save();
    // The Save button is the apply: a pick that cannot reach a running daemon without a setup run
    // must not sit silently as "saved" while the daemon keeps the old model.
    const request = scope.writes.find((ops) => ops.some((op) => op.path[0] === "setupRequest"));
    expect(request).toBeDefined();
    expect(scope.value.llmChoice).toBe("token::glm-5.3-flash");
    expect(face.hooks.hindsightCard.getSnapshot().setupPending).toBe(true);
  });

  it("does not ask for a setup when other controls are saved, or outside daemon mode", async () => {
    const other = new FakeScope({ serverMode: "daemon", llmChoice: "token::a" });
    {
      const { card, face } = controllerFor(other);
      card.stage("retainSessions", false);
      await face.save();
      expect(other.writes.some((ops) => ops.some((op) => op.path[0] === "setupRequest"))).toBe(false);
    }
    const external = new FakeScope({ serverMode: "self-hosted", llmChoice: "" });
    {
      const { card, face } = controllerFor(external);
      card.stage("llmChoice", "token::b");
      await face.save();
      expect(external.writes.some((ops) => ops.some((op) => op.path[0] === "setupRequest"))).toBe(false);
    }
    const blank = new FakeScope({ serverMode: "daemon", llmChoice: "token::a" });
    {
      const { card, face } = controllerFor(blank);
      card.stage("llmChoice", "");
      await face.save();
      expect(blank.writes.some((ops) => ops.some((op) => op.path[0] === "setupRequest"))).toBe(false);
    }
  });

  it("writes the token through the scope when one is typed", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    face.edit(SECRET_FIELD, "tok_123");
    await face.save();
    expect(scope.value[SECRET_FIELD]).toBe("tok_123");
  });

  it("reports whether a token is stored without ever receiving it", () => {
    const configured = controllerFor(new FakeScope(), mirror([{ path: [SECRET_FIELD], set: true }]));
    expect(configured.face.hooks.hindsightCard.getSnapshot().apiTokenConfigured).toBe(true);
    const empty = controllerFor(new FakeScope(), mirror([{ path: [SECRET_FIELD], set: false }]));
    expect(empty.face.hooks.hindsightCard.getSnapshot().apiTokenConfigured).toBe(false);
    // A Host that sends no markers at all must not be read as "no token".
    const silent = controllerFor(new FakeScope(), mirror(undefined));
    expect(silent.face.hooks.hindsightCard.getSnapshot().apiTokenKnown).toBe(false);
  });

  it("keeps a draft when the Host refuses the write", async () => {
    const scope = new FakeScope();
    const { card, face } = controllerFor(scope);
    card.stage("serverMode", "cloud");
    scope.mutate = async () => false;
    await face.save();
    const state = face.hooks.hindsightCard.getSnapshot();
    expect(state.failed).toBe(true);
    expect(state.dirty).toBe(true);
  });

  it("asks for a setup as one click: a request, and the config that request needs", async () => {
    const scope = new FakeScope({ serverMode: "cloud", enabled: false });
    const { face } = controllerFor(scope);
    const running = face.runSetup();
    // The page claims it is starting before the Host has said anything, because the click IS the
    // intent — otherwise the button would look inert for as long as a cold start takes.
    expect(face.hooks.hindsightCard.getSnapshot().setupPending).toBe(true);
    await running;
    expect(scope.value.serverMode).toBe("daemon");
    expect(scope.value.enabled).toBe(true);
    expect(typeof scope.value.setupRequest).toBe("string");
    expect(scope.value.setupRequest).not.toBe("");
  });

  it("does not turn the plugin back on when the user just switched it off", async () => {
    // The setup button is a vote for the local service, not for the master switch: staging
    // `enabled: false` and then clicking setup must not silently revert the user's staging.
    const scope = new FakeScope({ serverMode: "daemon", enabled: true });
    const { card, face } = controllerFor(scope);
    card.stage("enabled", false);
    await face.runSetup();
    // The run wrote no `enabled` at all: the staged "off" is the newer statement.
    const wroteEnabled = scope.writes.some((ops) => ops.some((op) => op.path[0] === "enabled"));
    expect(wroteEnabled).toBe(false);
    // And the request still went out: the run is the user's click, whatever the switch says.
    expect(typeof scope.value.setupRequest).toBe("string");
    // The staged "off" survives the run, so a Save still commits it.
    expect(face.hooks.hindsightCard.getSnapshot().enabled).toBe(false);
  });

  it("stops claiming it is starting once the Host answers", async () => {
    const scope = new FakeScope({ serverMode: "daemon" });
    const { face } = controllerFor(scope);
    await face.runSetup();
    scope.value.setupStatus = serializeSetupStatus({
      at: Date.now() + 1_000,
      phase: "ok",
      code: "ok",
      steps: [],
      service: { url: "http://127.0.0.1:9077", provider: "deepseek", model: "deepseek-chat", source: "settings" },
    });
    await scope.mutate([]);
    const state = face.hooks.hindsightCard.getSnapshot();
    expect(state.setupPending).toBe(false);
    expect(state.setupUnanswered).toBe(false);
    expect(state.setup?.phase).toBe("ok");
    expect(state.setup?.service?.model).toBe("deepseek-chat");
  });

  it("shows the previous run's result until a newer one arrives", async () => {
    const scope = new FakeScope({ serverMode: "daemon" });
    scope.value.setupStatus = serializeSetupStatus({ at: 1, phase: "failed", code: "uv-missing", steps: [] });
    const { face } = controllerFor(scope);
    const state = face.hooks.hindsightCard.getSnapshot();
    // Nothing pending: the last answer stands, and the button offers a retry for it.
    expect(state.setupPending).toBe(false);
    expect(state.setup?.code).toBe("uv-missing");
  });

  it("says the harness needs a restart when the Host refuses the request write", async () => {
    // The upgrade path: a page from a newer build against a host half whose Config schema predates
    // `setupRequest`. The write is refused, so nothing is pending and nothing will answer — the page
    // must say why instead of looking inert or claiming progress forever.
    const scope = new FakeScope({ serverMode: "daemon" });
    scope.mutate = async () => false;
    const { face } = controllerFor(scope);
    await face.runSetup();
    const state = face.hooks.hindsightCard.getSnapshot();
    expect(state.setupUnavailable).toBe(true);
    expect(state.setupPending).toBe(false);
  });

  it("clears that state on the next attempt", async () => {
    const scope = new FakeScope({ serverMode: "daemon" });
    scope.mutate = async () => false;
    const { face } = controllerFor(scope);
    await face.runSetup();
    expect(face.hooks.hindsightCard.getSnapshot().setupUnavailable).toBe(true);
    scope.mutate = FakeScope.prototype.mutate.bind(scope);
    await face.runSetup();
    expect(face.hooks.hindsightCard.getSnapshot().setupUnavailable).toBe(false);
  });

  it("stops claiming it is starting when the Host half never answers at all", async () => {
    vi.useFakeTimers();
    try {
      const scope = new FakeScope({ serverMode: "daemon" });
      const { face } = controllerFor(scope);
      await face.runSetup();
      expect(face.hooks.hindsightCard.getSnapshot().setupPending).toBe(true);
      // Past the answer window, "starting" would be a lie the user cannot act on — and no scope
      // write is coming (that is the scenario), so the CONTROLLER must publish on its own: the
      // timer runSetup armed is the only thing that can flip this state.
      await vi.advanceTimersByTimeAsync(SETUP_ANSWER_TIMEOUT_MS + 100);
      const state = face.hooks.hindsightCard.getSnapshot();
      expect(state.setupPending).toBe(false);
      expect(state.setupUnanswered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports unavailable while the Host does not serve the namespace, instead of an empty form", () => {
    const scope = new FakeScope();
    scope.status = "unavailable";
    const { face } = controllerFor(scope);
    expect(face.hooks.hindsightCard.getSnapshot().available).toBe(false);
  });
});

/**
 * The library list's own channel.
 *
 * It is a Fetch route rather than a settings write, so the browser side of it is stubbed at the
 * `fetch` boundary: what these tests pin is the page's reading of an answer — which states it can
 * reach, and what it does when the answer is late, missing or a refusal.
 */
describe("the settings page's library list", () => {
  const ROW = {
    bankId: "coding-agent::repo",
    label: "repo",
    factCount: 3,
    sessions: 2,
    lastWriteAt: "2026-10-15T10:01:40.000Z",
  };

  /**
   * One canned answer per call, in order; a function is called with the request for exactness.
   *
   * `text` is the reply a route that is NOT ours gives — the platform's own 404 is the plain body
   * `not found`, and the page's reading of "is this my route at all" turns on exactly that.
   */
  type Answer =
    | { status?: number; body?: unknown; text?: string }
    | "reject"
    | ((url: string, init: RequestInit) => unknown);

  /**
   * Install a `fetch` that answers the library route.
   *
   * @param answers - one entry per expected call, in order.
   * @returns the calls that were made, as `[url, init]` pairs.
   */
  function stubFetch(answers: Answer[]): Array<[string, RequestInit]> {
    const calls: Array<[string, RequestInit]> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit = {}) => {
      calls.push([url, init]);
      const answer = answers.shift();
      if (answer === undefined) throw new Error(`unexpected fetch: ${url}`);
      if (answer === "reject") throw new Error("ECONNREFUSED");
      if (typeof answer === "function") return answer(url, init);
      if (answer.text !== undefined) {
        return new Response(answer.text, { status: answer.status ?? 200, headers: { "content-type": "text/plain" } });
      }
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    });
    return calls;
  }

  const payload = (overrides: Record<string, unknown> = {}) => ({
    ok: true,
    endpoint: "http://127.0.0.1:9077",
    serverMode: "daemon",
    disabled: false,
    all: false,
    total: 1,
    hidden: 0,
    fetchedAt: "2026-10-15T10:02:00.000Z",
    libraries: [ROW],
    ...overrides,
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts idle, and holding the row the host sent once it answers", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    expect(face.hooks.hindsightCard.getSnapshot().libraries.status).toBe("idle");
    const calls = stubFetch([{ body: payload() }]);
    await face.refreshLibraries();
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.status).toBe("ready");
    expect(libraries.rows).toEqual([ROW]);
    expect(libraries.endpoint).toBe("http://127.0.0.1:9077");
    // Document-relative, with no leading slash: the page's route is resolved against the document.
    expect(calls[0]?.[0]).toBe("api/hindsight/libraries");
    expect(calls[0]?.[1].method).toBe("GET");
  });

  it("asks for every library on the server when the user widens the list", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    const calls = stubFetch([{ body: payload({ all: true, hidden: 4 }) }]);
    await face.refreshLibraries(true);
    expect(calls[0]?.[0]).toBe("api/hindsight/libraries?all=1");
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.all).toBe(true);
    expect(libraries.hidden).toBe(4);
  });

  it("calls a route that is not there 'unavailable', which is a restart rather than a retry", async () => {
    // A page from this build against a host half from before it: the connection service has no such
    // path, so the answer is a 404 and the page must say so instead of blaming the server.
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    stubFetch([{ status: 404, text: "not found" }]);
    await face.refreshLibraries();
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.status).toBe("unavailable");
    expect(libraries.error).toBeUndefined();
  });

  it("reports a server that does not answer, with the reason, and keeps the list it had", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    stubFetch([{ body: payload() }, "reject"]);
    await face.refreshLibraries();
    await face.refreshLibraries();
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.status).toBe("error");
    expect(libraries.error).toBe("ECONNREFUSED");
    // The rows are still there: a refresh that failed says nothing about what the server holds.
    expect(libraries.rows).toEqual([ROW]);
  });

  it("does not let an older listing overwrite a newer one", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    let releaseFirst: (() => void) | undefined;
    const first = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    stubFetch([
      async () => {
        await first;
        return new Response(JSON.stringify(payload({ libraries: [{ ...ROW, label: "stale" }] })), { status: 200 });
      },
      { body: payload({ libraries: [{ ...ROW, label: "fresh" }] }) },
    ]);
    const slow = face.refreshLibraries();
    await face.refreshLibraries();
    releaseFirst?.();
    await slow;
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.rows[0]?.label).toBe("fresh");
  });

  it("rolls the view toggle back when a widened refresh fails", async () => {
    // The list stays on screen with the rows of the view that WAS showing; the toggle button and
    // the hidden count must not claim the view the failed refresh asked for.
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    stubFetch([{ body: payload() }, "reject"]);
    await face.refreshLibraries();
    await face.refreshLibraries(true);
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.status).toBe("error");
    expect(libraries.rows).toEqual([ROW]);
    expect(libraries.all).toBe(false); // rolled back, not stuck on the failed request's view
  });

  it("removes a library through the route, and repaints from the answer to the delete", async () => {
    const scope = new FakeScope();
    const { card, face } = controllerFor(scope);
    const calls = stubFetch([{ body: payload() }, { body: payload({ total: 0, libraries: [] }) }]);
    await face.refreshLibraries();
    face.askRemove(ROW.bankId);
    expect(card.inject().hooks.hindsightCard.getSnapshot().libraries.confirming).toBe(ROW.bankId);
    await face.confirmRemove();
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    const [, init] = calls[1]!;
    expect(calls[1]?.[0]).toBe("api/hindsight/libraries");
    expect(init.method).toBe("POST");
    expect(JSON.parse(String(init.body))).toEqual({ action: "delete", bankId: ROW.bankId });
    expect(libraries.confirming).toBeUndefined();
    expect(libraries.rows).toEqual([]);
    // Named, not just gone: a row that silently disappears reads as a rendering bug.
    expect(libraries.removedLabel).toBe("repo");
  });

  it("sends nothing at all until a delete is confirmed", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    const calls = stubFetch([{ body: payload() }]);
    await face.refreshLibraries();
    face.askRemove(ROW.bankId);
    face.cancelRemove();
    expect(face.hooks.hindsightCard.getSnapshot().libraries.confirming).toBeUndefined();
    expect(calls).toHaveLength(1);
  });

  it("keeps the list on screen when the host refuses the delete", async () => {
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    stubFetch([
      { body: payload() },
      { status: 404, body: { ok: false, code: "refused", error: "no such bank on this server: gone" } },
    ]);
    await face.refreshLibraries();
    face.askRemove(ROW.bankId);
    await face.confirmRemove();
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.error).toBe("no such bank on this server: gone");
    expect(libraries.rows).toEqual([ROW]);
    expect(libraries.removedLabel).toBeUndefined();
  });

  it("does not deadlock when a refresh races a slow delete", async () => {
    // The old bug: the refresh bumped the generation while the delete was in flight, the delete's
    // answer was dropped on its generation check — BEFORE its cleanup ran — and `deleting`/
    // `confirming` stayed set forever: every delete button disabled, the confirmation dialog open
    // and its Cancel disabled. The guard on loadLibraries plus cleanup-before-check closes both
    // doors: the refresh is refused mid-delete, and even a generation bump that slips through
    // cannot strand the lock.
    const scope = new FakeScope();
    const { face } = controllerFor(scope);
    let releaseDelete: (() => void) | undefined;
    const deleted = new Promise<void>((resolve) => {
      releaseDelete = resolve;
    });
    stubFetch([
      { body: payload() },
      async () => {
        await deleted;
        return new Response(JSON.stringify(payload({ total: 0, libraries: [] })), { status: 200 });
      },
      { body: payload({ all: true, hidden: 0 }) },
    ]);
    await face.refreshLibraries();
    face.askRemove(ROW.bankId);
    const confirming = face.confirmRemove();
    // While the delete is in flight, a refresh click must be a no-op — the delete's own answer
    // repaints, and a racing generation would strand the delete's lock.
    await face.refreshLibraries(true);
    expect(face.hooks.hindsightCard.getSnapshot().libraries.status).not.toBe("loading");
    releaseDelete?.();
    await confirming;
    const libraries = face.hooks.hindsightCard.getSnapshot().libraries;
    expect(libraries.deleting).toBeUndefined();
    expect(libraries.confirming).toBeUndefined();
    expect(libraries.rows).toEqual([]);
    expect(libraries.removedLabel).toBe("repo");
  });
});
