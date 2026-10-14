import { afterEach, describe, expect, it, vi } from "vitest";
import type { SettingsOp, SettingsScope, SettingsScopeSnapshot } from "@deepseek-ai/dsh-client-ui-primitives";
import { HindsightCardController } from "./controller";
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
    expect(scope.writes[0]).toEqual([{ op: "set", path: ["serverMode"], value: "self-hosted" }]);
    expect(scope.writes[1]).toEqual([{ op: "set", path: ["apiUrl"], value: "http://localhost:9999" }]);
    // Both halves clear on success, so Save goes inert again.
    expect(face.hooks.hindsightCard.getSnapshot().dirty).toBe(false);
    expect(scope.value.serverMode).toBe("self-hosted");
    expect(scope.value.apiUrl).toBe("http://localhost:9999");
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
      // Past the answer window, "starting" would be a lie the user cannot act on.
      vi.setSystemTime(Date.now() + 21_000);
      await scope.mutate([]);
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
