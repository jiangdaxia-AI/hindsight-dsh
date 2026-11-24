import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../vendor/coding-agents/src/core/config";
import { DEFAULT_SETTINGS, type DshSettings } from "./fields";
import { apply, Config, default as plugin, inject, name, pendingSetupRequest, publishSpawnCredentials, readSettings } from "./host";
import { toRuntimeConfig } from "./settings";
import { spawnCredentialEnv, SPAWN_CREDENTIALS_PATH } from "../vendor/coding-agents/src/core/spawn-credentials";

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** The settings writer drains on a module-load interval, so one write needs a tick to land. */
const flushWrites = () => new Promise((resolve) => setTimeout(resolve, 200));

/** A host context that records what the plugin bound, without a Cordis runtime behind it. */
function stubContext(services: Record<string, unknown> = {}) {
  const events: string[] = [];
  const errors: unknown[] = [];
  const listeners = new Map<string, Set<() => void>>();
  let toolCallback: (() => void) | undefined;
  const ctx = {
    on(event: string, listener: () => void) {
      events.push(event);
      const forEvent = listeners.get(event) ?? new Set();
      forEvent.add(listener);
      listeners.set(event, forEvent);
      return () => {};
    },
    // Cordis only runs an inject callback once every dependency it names is available.
    inject(deps: string[], callback: (child?: unknown) => void) {
      if (deps.includes("tools")) toolCallback = callback;
      if (deps.every((dep) => services[dep] !== undefined)) callback(ctx);
      return () => {};
    },
    effect(callback: () => (() => void) | void) {
      return callback();
    },
    get(name: string) {
      return services[name];
    },
    fiber: {},
    logger: { error: (message: unknown) => errors.push(message) },
  };
  return {
    ctx,
    events,
    errors,
    /** Fire one event on the shared bus; unqualified calls are the plugin's own config write. */
    emit: (event = "loader/volatile-update") => [...(listeners.get(event) ?? [])].forEach((listener) => listener()),
    toolsBound: () => toolCallback !== undefined,
  };
}

/**
 * A Settings service stand-in.
 *
 * `describe()` returns nothing unless a test supplies a document: the setup must find no model by
 * default, so nothing here can reach the point of starting a daemon.
 *
 * @param describe - the settings document this stub reports, for the tests that need one.
 */
function stubSettings(describe?: () => Array<{ ns: string; value?: unknown }>) {
  const updates: Array<Record<string, unknown>> = [];
  const policies: Array<{ auto?: boolean }> = [];
  const mutations: Array<Array<{ op: string; path: string[]; value?: unknown }>> = [];
  return {
    updates,
    policies,
    mutations,
    service: {
      configure: (policy: { auto?: boolean }) => policies.push(policy),
      describe: describe ?? (() => []),
      update: async (_ns: string, patch: Record<string, unknown>) => {
        updates.push(patch);
      },
      mutate: async (_ns: string, ops: Array<{ op: string; path: string[]; value?: unknown }>) => {
        mutations.push(ops);
      },
    },
  };
}

/** A config field as the Loader hands a `.volatile()` field to `apply`: a live reference. */
function ref<T>(initial: T) {
  let current = initial;
  return {
    get: () => current,
    // The same key `cosmokit`'s createVolatile installs, taken from the global registry.
    [Symbol.for("cosmokit.volatile.write")]: (next: T) => {
      current = next;
    },
    /** Test-side writer, standing in for the Loader's `updateVolatile`. */
    write: (next: T) => {
      current = next;
    },
  };
}

/** A validated Config, every field wrapped the way the Loader wraps a volatile one. */
function volatileConfig(overrides: Partial<DshSettings> = {}) {
  const values: DshSettings = { ...DEFAULT_SETTINGS, ...overrides };
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, ref(value)]));
}

describe("host plugin", () => {
  it("declares the entry identity the patch row and the settings page both use", () => {
    expect(name).toBe("hindsight");
    expect(inject).toEqual(["agents"]);
    expect(Config).toBeDefined();
  });

  it("carries Config on the default export, which is the one the Loader mounts", () => {
    // Cordis's `unwrapExports` prefers `exports.default` over the module namespace and reads
    // `Config` from the object it picked. A default without Config yields an entry that loads and
    // binds cleanly and reports NO schema — which on this host means no settings namespace, no
    // page, and nothing in any log to explain it.
    expect(plugin.Config).toBe(Config);
    expect(plugin.apply).toBe(apply);
    expect(plugin.name).toBe(name);
    expect(plugin.inject).toEqual(inject);
  });

  it("binds the dsh lifecycle the runtime needs", () => {
    const { ctx, events } = stubContext();
    apply(ctx as never, volatileConfig());
    // The six events the integration binds on a 0.2.x host: the 0.1.x name plus its replacement,
    // the pre-step waterfall, the turn boundary, disposal, and the append feed compaction rides.
    expect(events).toContain("agent/session-start");
    expect(events).toContain("agent/created");
    expect(events).toContain("agent/pre-step");
    expect(events).toContain("agent/turn-stopping");
    expect(events).toContain("agent/disposed");
    expect(events).toContain("session/event");
  });

  it("re-reads the saved config when a volatile write lands", () => {
    // A volatile write does NOT remount the plugin, so nothing re-reads the config on its own and
    // the cached per-repo workspaces would keep the endpoint, bank and opt-out they were built
    // with. The listener is the only thing that republishes them.
    const { ctx, events } = stubContext();
    apply(ctx as never, volatileConfig());
    expect(events).toContain("loader/volatile-update");
  });

  it("takes the config as its second argument and never reaches for ctx.config", () => {
    // The regression this guards: `ctx.config` is not a service, so reading it throws
    // `cannot get property "config" without inject` from Cordis's context proxy — at load time,
    // which fails the Loader entry and takes the application's boot with it. A context with NO
    // config property at all must still bind cleanly.
    const { ctx, errors } = stubContext();
    expect("config" in ctx).toBe(false);
    apply(ctx as never, volatileConfig({ serverMode: "self-hosted", apiUrl: "http://localhost:8888" }));
    expect(errors).toEqual([]);
  });

  it("fails open when binding throws, so a bad plugin cannot stop the host from booting", () => {
    const { ctx, errors } = stubContext();
    const broken = {
      on() {
        throw new Error("bind exploded");
      },
      logger: ctx.logger,
    };
    expect(() => apply(broken as never, volatileConfig())).not.toThrow();
    expect(String(errors[0])).toContain("bind exploded");
  });

  it("binds when dsh's services are reachable only from the injected child, as Cordis has them", () => {
    // What the REAL host looks like. The plugin's own context injects the agent registry alone, so
    // `ctx.get` finds nothing in the fibre's own store and a direct read of `llm`/`settings`/
    // `credentials` THROWS — `cannot get property "llm" without inject`. Those three are reachable
    // only from the child context `ctx.inject` hands its callback. Reading the facts off the
    // plugin's own context used to throw into the fail-open catch below, so no hook and no tool was
    // ever registered: every session ran memoryless, and the plugin log stayed empty because the
    // bind line never ran (2026-10-14).
    const services: Record<string, unknown> = { settings: stubSettings().service, credentials: {}, llm: {} };
    const listeners = new Map<string, Set<() => void>>();
    const errors: unknown[] = [];
    let toolsBound = false;
    const ctx = new Proxy(
      {
        on(event: string, listener: () => void) {
          const forEvent = listeners.get(event) ?? new Set();
          forEvent.add(listener);
          listeners.set(event, forEvent);
          return () => {};
        },
        inject(deps: string[], callback: (child?: unknown) => void) {
          // `tools` is the runtime's registry, bound last: reaching it is the proof the bind
          // completed rather than degrading. The rest is cordis's own dependency gate.
          if (deps.includes("tools")) toolsBound = true;
          else if (deps.every((dep) => services[dep] !== undefined)) callback(services);
          return () => {};
        },
        effect: (callback: () => (() => void) | void) => callback(),
        // Cordis answers `get` from the fibre's own store, which holds no sibling service.
        get: () => undefined,
        fiber: {},
        logger: { error: (message: unknown) => errors.push(message) },
      },
      {
        get(target, prop, receiver) {
          if (typeof prop === "string" && prop in services) {
            throw new Error(`cannot get property "${prop}" without inject`);
          }
          return Reflect.get(target, prop, receiver);
        },
      }
    );
    expect(() => apply(ctx as never, volatileConfig())).not.toThrow();
    // Nothing reached the fail-open catch, and the runtime was bound.
    expect(errors).toEqual([]);
    expect(toolsBound).toBe(true);
  });

  it("registers the settings page's library route on the connection service", () => {
    // The page's list and its delete need a request/response channel, which the settings document
    // is not. This is the host half of it: one exact Fetch route, at the path the browser half
    // derives its document-relative caller from, answering both verbs.
    const routes: Array<{ path: string; methods: string[]; requestBody: string }> = [];
    const connection = {
      fetch: {
        register: (route: { path: string; methods: string[]; requestBody: string }) => {
          routes.push(route);
          return () => {};
        },
      },
    };
    // Cordis hands `inject` a CHILD context on which the injected services are properties; the
    // shared stub hands back the parent, so this test supplies the child, as the one above does.
    const base = stubContext().ctx;
    const ctx = {
      ...base,
      inject: (deps: string[], callback: (child?: unknown) => void) => {
        if (deps.includes("connection")) callback({ ...base, connection });
        return () => {};
      },
    };
    apply(ctx as never, volatileConfig());
    expect(routes).toHaveLength(1);
    expect(routes[0]?.path).toBe("/api/hindsight/libraries");
    expect(routes[0]?.methods).toEqual(["GET", "POST"]);
    // Buffered: the delete's body is JSON the handler is about to read.
    expect(routes[0]?.requestBody).toBe("buffered");
  });

  it("binds without a connection service, because a headless run has no page to serve", () => {
    // The route is optional exactly like `settings` and `commands`: this is still the memory plugin
    // without a web transport, and failing the bind over a route would take memory down with it. The
    // page renders its own "restart dsh" state against that case.
    const { ctx, errors } = stubContext();
    expect(() => apply(ctx as never, volatileConfig())).not.toThrow();
    expect(errors).toEqual([]);
  });

  it("binds when the connection service is there but carries no fetch registry", () => {
    // A Connection that exposes no exact-route table must degrade the same way an absent one does,
    // rather than throwing from a property read on the injected child.
    const routes: unknown[] = [];
    const base = stubContext().ctx;
    const ctx = {
      ...base,
      inject: (deps: string[], callback: (child?: unknown) => void) => {
        if (deps.includes("connection")) callback({ ...base, connection: {} });
        return () => {};
      },
    };
    expect(() => apply(ctx as never, volatileConfig())).not.toThrow();
    expect(routes).toEqual([]);
  });
});

describe("the one-click setup's trigger", () => {
  it("treats a changed nonce as one request and an unchanged one as none", () => {
    // The page mints a fresh nonce per click; the host clears the field when it accepts.
    expect(pendingSetupRequest("", { setupRequest: "abc" })).toBe("abc");
    expect(pendingSetupRequest("abc", { setupRequest: "abc" })).toBeUndefined();
    expect(pendingSetupRequest("abc", { setupRequest: "def" })).toBe("def");
    // Blank is "nothing asked" — including the clear the host itself writes.
    expect(pendingSetupRequest("abc", { setupRequest: "" })).toBeUndefined();
    expect(pendingSetupRequest("abc", { setupRequest: "   " })).toBeUndefined();
    expect(pendingSetupRequest("abc", {})).toBeUndefined();
  });

  it("claims no request from a value that was already there when the plugin loaded", () => {
    // A nonce left behind by a crash must not re-run the setup on the next boot: the plugin adopts
    // whatever is in the document as the value it has already seen.
    const { ctx, emit } = stubContext();
    apply(ctx as never, volatileConfig({ setupRequest: "stale" }));
    expect(() => emit()).not.toThrow();
  });
});

describe("the setup's reporting channel", () => {
  it("registers its own settings page and keeps the generic form out of the way", () => {
    const { service, policies } = stubSettings();
    // The inject that registers the page policy waits for `settings`, `credentials` AND `llm`,
    // so the stub composition has to offer all three before its callback can run.
    const { ctx } = stubContext({ settings: service, credentials: {}, llm: {} });
    apply(ctx as never, volatileConfig());
    // `configure({auto:false})` is this plugin's side of shipping its own page: without it the
    // harness projects a second, schema-generated form beside it.
    expect(policies).toEqual([{ auto: false }]);
  });

  it("binds without a Settings service, losing progress reporting but not memory", () => {
    const { ctx, errors } = stubContext();
    apply(ctx as never, volatileConfig({ serverMode: "daemon" }));
    expect(errors).toEqual([]);
  });

  it("writes nothing into the settings document until something asks for a setup", () => {
    const { service, updates } = stubSettings();
    const { ctx, emit } = stubContext({ settings: service });
    apply(ctx as never, volatileConfig());
    emit();
    expect(updates).toEqual([]);
  });
});

describe("the model choice list", () => {
  /**
   * The settings document a host configured for the "deepseek" route would report.
   *
   * The models are read through a getter rather than captured, because "dsh's model list changed"
   * IS a change to this document after the plugin bound.
   */
  const document = (models: () => string[]) => () => [
    { ns: "llm-deepseek", value: { providers: { deepseek: { models: models() } } } },
  ];

  it("publishes the models dsh offers once the services arrive", async () => {
    const { service, mutations } = stubSettings(document(() => ["deepseek-chat"]));
    const { ctx } = stubContext({ settings: service, credentials: {}, llm: { listProviders: () => [{ id: "deepseek" }] } });
    apply(ctx as never, volatileConfig());
    await flushWrites();
    expect(mutations.at(-1)?.[0]).toMatchObject({
      op: "set",
      path: ["modelChoices"],
      value: '[{"route":"deepseek","model":"deepseek-chat"}]',
    });
  });

  it("republishes when dsh's own model list changes, not only when this plugin is saved", async () => {
    // The regression: the loader delivers its volatile-update event to the plugin whose OWN
    // config changed, so a model added, renamed or removed under Settings -> Models never reached
    // this half and the pick kept the list published at load. The host announces such a write on
    // the shared event bus, which this plugin can hear.
    let models = ["deepseek-chat"];
    const { service, mutations } = stubSettings(document(() => models));
    const { ctx, emit } = stubContext({ settings: service, credentials: {}, llm: { listProviders: () => [{ id: "deepseek" }] } });
    apply(ctx as never, volatileConfig());
    await flushWrites();
    const before = mutations.length;

    models = ["deepseek-chat", "deepseek-reasoner"];
    emit("settings/document-updated");
    await flushWrites();
    expect(mutations.length).toBeGreaterThan(before);
    expect(mutations.at(-1)?.[0]).toMatchObject({
      value: '[{"route":"deepseek","model":"deepseek-chat"},{"route":"deepseek","model":"deepseek-reasoner"}]',
    });
  });

  it("also follows an adapter appearing or disappearing", async () => {
    // A route with no adapter is invisible to the list, so the models it declares under the same
    // settings document only enter the pick when its adapter registers.
    let routes = [{ id: "deepseek" }];
    const models = () => ["deepseek-chat"];
    const withGlm = () => [
      { ns: "llm-deepseek", value: { providers: { deepseek: { models: models() }, glm: { models: ["glm-4.6"] } } } },
    ];
    const { service, mutations } = stubSettings(withGlm);
    const { ctx, emit } = stubContext({ settings: service, credentials: {}, llm: { listProviders: () => routes } });
    apply(ctx as never, volatileConfig());
    await flushWrites();
    const before = mutations.length;

    routes = [{ id: "deepseek" }, { id: "glm" }];
    emit("llm/adapters-updated");
    await flushWrites();
    expect(mutations.length).toBeGreaterThan(before);
    expect(mutations.at(-1)?.[0]).toMatchObject({
      path: ["modelChoices"],
      value: '[{"route":"deepseek","model":"deepseek-chat"},{"route":"glm","model":"glm-4.6"}]',
    });
  });

  it("clears the list when dsh's last model is removed", async () => {
    // A published list must not outlive the models it named. The removal arrives as another
    // document update, and an empty read now means "there are none" rather than "could not read".
    let models = ["deepseek-chat"];
    const { service, mutations } = stubSettings(document(() => models));
    const { ctx, emit } = stubContext({ settings: service, credentials: {}, llm: { listProviders: () => [{ id: "deepseek" }] } });
    const config = volatileConfig();
    apply(ctx as never, config);
    await flushWrites();
    // The real loader folds what the plugin wrote back into its own live reference.
    (config.modelChoices as unknown as { write(value: string): void }).write(
      '[{"route":"deepseek","model":"deepseek-chat"}]'
    );

    models = [];
    emit("settings/document-updated");
    await flushWrites();
    expect(mutations.at(-1)?.[0]).toMatchObject({ path: ["modelChoices"], value: "[]" });
  });
});

describe("readSettings", () => {
  it("unwraps the live reference every volatile field arrives as", () => {
    const settings = readSettings(volatileConfig({ serverMode: "cloud", apiPort: 1234 }));
    expect(settings.serverMode).toBe("cloud");
    expect(settings.apiPort).toBe(1234);
  });

  it("reads through the reference, so a value saved after load is the value in force", () => {
    // This is what a settings-page save looks like from here: the Loader writes the new value into
    // the SAME reference object (cosmokit's updateVolatile), without remounting the plugin.
    const config = volatileConfig({ serverMode: "daemon" });
    expect(readSettings(config).serverMode).toBe("daemon");
    (config.serverMode as unknown as { write(value: string): void }).write("self-hosted");
    expect(readSettings(config).serverMode).toBe("self-hosted");
  });

  it("accepts plain values too, so a host that validates nothing still works", () => {
    expect(readSettings({ serverMode: "cloud", apiPort: 9077 })).toMatchObject({ serverMode: "cloud", apiPort: 9077 });
  });

  it("returns nothing for a config that never arrived", () => {
    expect(readSettings(undefined)).toEqual({});
    expect(readSettings(null)).toEqual({});
    expect(readSettings("nonsense")).toEqual({});
  });
});

describe("config seam", () => {
  it("lets the host layer win over the shared file, and the file keep everything else", () => {
    dir = mkdtempSync(join(tmpdir(), "hs-seam-"));
    const file = join(dir, "coding-agent.json");
    writeFileSync(
      file,
      JSON.stringify({
        serverMode: "cloud",
        apiUrl: "https://file.example",
        apiToken: "file-token",
        bankId: "file-bank",
        retainSessions: false,
      })
    );
    // The page set the endpoint and left the token and bank id blank: the file's values must survive.
    const overrides = toRuntimeConfig(readSettings(volatileConfig({ serverMode: "self-hosted", apiUrl: "http://localhost:8888", adopted: true })));
    const cfg = loadConfig({ path: file, harness: "dsh", overrides });
    expect(cfg.serverMode).toBe("self-hosted");
    expect(cfg.apiUrl).toBe("http://localhost:8888");
    expect(cfg.apiToken).toBe("file-token");
    expect(cfg.bankId).toBe("file-bank");
    // A switch the page DOES render is projected, so its saved value is what the runtime uses.
    expect(cfg.retainSessions).toBe(true);
  });

  it("keeps the shared file entirely in force for a page that was never saved", () => {
    // The overrides layer outranks the file, and every volatile field reads as its DEFAULT until
    // the user saves — indistinguishable from a deliberate choice of that default. Before
    // `adopted` is set, the page must project nothing: a hand-configured file is not to be
    // overridden by defaults the user never saw. (The defaults differ from the file on every
    // projected field, so a single leaked field fails an assertion below.)
    dir = mkdtempSync(join(tmpdir(), "hs-seam-"));
    const file = join(dir, "coding-agent.json");
    writeFileSync(
      file,
      JSON.stringify({
        serverMode: "self-hosted",
        apiUrl: "https://file.example",
        apiToken: "file-token",
        bankId: "file-bank",
        apiPort: 1234,
        retainSessions: false,
        optInOnly: true,
        logLevel: "debug",
      })
    );
    const overrides = toRuntimeConfig(readSettings(volatileConfig()));
    expect(overrides).toEqual({}); // never saved: nothing projected
    const cfg = loadConfig({ path: file, harness: "dsh", overrides });
    expect(cfg.serverMode).toBe("self-hosted");
    expect(cfg.apiUrl).toBe("https://file.example");
    expect(cfg.apiToken).toBe("file-token");
    expect(cfg.bankId).toBe("file-bank");
    expect(cfg.apiPort).toBe(1234);
    expect(cfg.retainSessions).toBe(false);
    expect(cfg.optInOnly).toBe(true);
    expect(cfg.logLevel).toBe("debug");
  });
});

describe("spawn credentials", () => {
  it("never carries the token in the exported overrides layer a descendant would inherit", () => {
    // The overrides variable travels by inheritance: every descendant of this host — including
    // the test runners and scripts the AGENT spawns in its sessions — sees it. apply() exports
    // the layer on bind; the token must never be in THAT string, and must instead be in the
    // spawn-credentials file, which only a Hindsight child's own spawn boundary reads.
    const credFile = join(tmpdir(), "hs-spawn-cred-seam.json");
    process.env.HINDSIGHT_SPAWN_CREDENTIALS = credFile;
    try {
      delete process.env.HINDSIGHT_HOST_OVERRIDES;
      const { ctx } = stubContext();
      apply(ctx as never, volatileConfig({ adopted: true, apiToken: "tok_123" }));
      const exported = JSON.parse(process.env.HINDSIGHT_HOST_OVERRIDES ?? "null") as Record<string, unknown> | null;
      expect(exported).not.toBeNull();
      expect("apiToken" in (exported as Record<string, unknown>)).toBe(false);
      expect(spawnCredentialEnv()).toEqual({ HINDSIGHT_API_TOKEN: "tok_123" });
    } finally {
      delete process.env.HINDSIGHT_SPAWN_CREDENTIALS;
      delete process.env.HINDSIGHT_HOST_OVERRIDES;
      rmSync(credFile, { force: true });
    }
  });

  it("records the token in the 0600 spawn-credentials file, and clears it when the setting clears", () => {
    // The file is the ONLY route the token takes to the children: nodeLaunch injects it into the
    // one child being spawned (see core/spawn-credentials.ts), so no other descendant sees it.
    const file = join(tmpdir(), "hs-spawn-cred-test.json");
    process.env.HINDSIGHT_SPAWN_CREDENTIALS = file;
    try {
      publishSpawnCredentials("tok_123");
      expect(spawnCredentialEnv()).toEqual({ HINDSIGHT_API_TOKEN: "tok_123" });
      // A cleared page token clears the file: a stale credential must not outlive its setting.
      publishSpawnCredentials(undefined);
      expect(spawnCredentialEnv()).toEqual({});
    } finally {
      delete process.env.HINDSIGHT_SPAWN_CREDENTIALS;
      rmSync(file, { force: true });
    }
  });

  it("treats an unreadable credentials file as no credential at all", () => {
    const file = join(tmpdir(), "hs-spawn-cred-broken.json");
    process.env.HINDSIGHT_SPAWN_CREDENTIALS = file;
    try {
      writeFileSync(file, "{not json");
      expect(spawnCredentialEnv()).toEqual({});
    } finally {
      delete process.env.HINDSIGHT_SPAWN_CREDENTIALS;
      rmSync(file, { force: true });
    }
  });
});
