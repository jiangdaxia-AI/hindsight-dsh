import { describe, expect, it } from "vitest";
import {
  modelFromChoice,
  modelFromExplicitEnv,
  modelFromHarness,
  needsRestartFor,
  runSetup,
  type DaemonModel,
  type SetupDeps,
} from "./setup";
import { parseSetupStatus, serializeSetupStatus, type SetupStatus } from "./setup-types";

/** The runner with everything faked: no child process, no network, and a clock the test drives. */
function harness(overrides: Partial<SetupDeps> = {}) {
  const published: SetupStatus[] = [];
  let clock = 1_000;
  const base: SetupDeps = {
    settings: { serverMode: "daemon" },
    env: {},
    publish: (status) => published.push(status),
    ensureUv: () => ({ alreadyOnPath: true }),
    hasUvx: () => true,
    installUv: async () => ({ ok: true }),
    // A model is available by default so a test about a LATER step is not stopped by this one;
    // the tests that are about the model override it.
    resolveHarnessModel: async () => ({ provider: "test-model-provider", source: "test double" }),
    daemonTarget: () => ({ apiUrl: "http://127.0.0.1:9077", port: 9077 }),
    startDaemon: () => {},
    healthy: async () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    waitMs: 4_000,
    pollMs: 1_000,
  };
  return { deps: { ...base, ...overrides } as SetupDeps, published };
}

describe("choosing the local server's model", () => {
  it("resolves the user's pick against the same harness facts as the default", async () => {
    const model = await modelFromChoice(
      { llmChoice: "token::glm-5.3" },
      {
        routes: ["token"],
        active: { provider: "token", model: "deepseek-flash" },
        namespaces: [
          {
            ns: "llm-pi-ai",
            value: {
              providers: {
                token: {
                  api: "openai-completions",
                  baseURL: "https://gateway.example/v1",
                  apiKeyEnv: "TOKEN_API_KEY",
                  models: [{ id: "deepseek-flash" }, { id: "glm-5.3" }],
                },
              },
            },
          },
        ],
        resolveCredential: async () => "sk-harness",
      }
    );
    expect(model).toMatchObject({
      provider: "openai",
      baseUrl: "https://gateway.example/v1",
      model: "glm-5.3",
      apiKey: "sk-harness",
    });
    expect(model?.source).toContain("token::glm-5.3");
  });

  it("reads no decision out of a blank or malformed pick", async () => {
    const facts = { routes: [], namespaces: [] };
    await expect(modelFromChoice({ llmChoice: "" }, facts)).resolves.toBeUndefined();
    await expect(modelFromChoice({ llmChoice: "   " }, facts)).resolves.toBeUndefined();
    await expect(modelFromChoice({ llmChoice: "no-separator" }, facts)).resolves.toBeUndefined();
    await expect(modelFromChoice({}, facts)).resolves.toBeUndefined();
  });

  it("returns nothing when the pick names a route dsh no longer has", async () => {
    await expect(
      modelFromChoice({ llmChoice: "gone::m" }, { routes: ["other"], namespaces: [] })
    ).resolves.toBeUndefined();
  });

  it("reads a model stated for Hindsight itself, but never another tool's ambient key", () => {
    expect(modelFromExplicitEnv({ HINDSIGHT_API_LLM_PROVIDER: "openai", HINDSIGHT_API_LLM_API_KEY: "sk-x" })).toMatchObject({
      provider: "openai",
      apiKey: "sk-x",
      source: "HINDSIGHT_API_LLM_PROVIDER",
    });
    // A key that belongs to some other tool is not this setup's to spend.
    expect(modelFromExplicitEnv({ OPENAI_API_KEY: "sk-env" })).toBeUndefined();
    expect(modelFromExplicitEnv({})).toBeUndefined();
  });

  it("reuses the provider dsh is already talking to, key and endpoint included", async () => {
    const resolved: string[] = [];
    const model = await modelFromHarness({
      routes: ["token"],
      active: { provider: "token", model: "deepseek-flash" },
      namespaces: [
        { ns: "agent-default-model", value: { provider: "token", model: "deepseek-flash" } },
        {
          ns: "llm-pi-ai",
          value: {
            providers: {
              token: {
                api: "openai-completions",
                baseURL: "https://gateway.example/v1",
                apiKeyEnv: "TOKEN_API_KEY",
                models: [{ id: "deepseek-flash" }, { id: "glm-5.3" }],
              },
            },
          },
        },
      ],
      resolveCredential: async (ref) => {
        resolved.push(ref);
        return "sk-harness";
      },
    });
    expect(resolved).toEqual(["TOKEN_API_KEY"]);
    expect(model).toMatchObject({
      provider: "openai",
      baseUrl: "https://gateway.example/v1",
      model: "deepseek-flash",
      apiKey: "sk-harness",
      source: "llm-pi-ai/token (TOKEN_API_KEY)",
    });
  });

  it("keeps a provider's own service by name when the route names no endpoint", async () => {
    const model = await modelFromHarness({
      routes: ["deepseek-official"],
      active: { provider: "deepseek-official" },
      namespaces: [{ ns: "llm-deepseek", value: { providers: { "deepseek-official": { models: ["deepseek-chat"] } } } }],
    });
    expect(model).toMatchObject({ provider: "deepseek", model: "deepseek-chat" });
  });

  it("returns nothing when dsh offers no route at all", async () => {
    expect(await modelFromHarness({ routes: [], namespaces: [] })).toBeUndefined();
  });
});

describe("one-click setup", () => {
  it("reports each step and ends ready, with the service and model it used", async () => {
    let probes = 0;
    const { deps, published } = harness({
      settings: { serverMode: "daemon" },
      resolveChosenModel: async () => ({ provider: "deepseek", model: "deepseek-chat", source: "choice: token::deepseek-chat" }),
      healthy: async () => {
        probes += 1;
        return probes > 1;
      },
      startDaemon: () => {},
    });
    const status = await runSetup(deps);
    expect(status.phase).toBe("ok");
    expect(status.code).toBe("ok");
    expect(status.service).toEqual({
      url: "http://127.0.0.1:9077",
      provider: "deepseek",
      model: "deepseek-chat",
      source: "choice: token::deepseek-chat",
    });
    expect(status.steps.map((step) => step.id)).toEqual(["uv", "model", "service"]);
    // Progress first, answer last: the page shows the last one it received.
    expect(published.map((entry) => entry.phase)).toEqual(["running", "running", "running", "ok"]);
    expect(published.at(-1)?.at).toBe(status.at);
  });

  it("adopts a service that is already answering instead of starting a second one", async () => {
    let started = 0;
    const { deps } = harness({
      healthy: async () => true,
      startDaemon: () => {
        started += 1;
      },
    });
    const status = await runSetup(deps);
    expect(started).toBe(0);
    expect(status.phase).toBe("ok");
    expect(status.steps.find((step) => step.id === "service")?.detail).toContain("already running");
  });

  it("compares the model the last run recorded with the one being applied", () => {
    // No record: a daemon this plugin never started is left alone rather than restarted blindly.
    expect(needsRestartFor(undefined, { provider: "openai", model: "a" })).toBe(false);
    expect(needsRestartFor({ provider: "openai", model: "a" }, { provider: "openai", model: "a" })).toBe(false);
    expect(needsRestartFor({ provider: "openai", model: "a" }, { provider: "openai", model: "b" })).toBe(true);
    expect(needsRestartFor({ provider: "openai", model: "a" }, { provider: "deepseek", model: "a" })).toBe(true);
    // A provider-only model (claude-code needs no model name) compares on what is there.
    expect(needsRestartFor({ provider: "claude-code" }, { provider: "claude-code" })).toBe(false);
    expect(needsRestartFor({ provider: "claude-code" }, { provider: "openai", model: "a" })).toBe(true);
  });

  it("restarts an answering service when its model is no longer the one being applied", async () => {
    let started: { restart?: boolean } | undefined;
    const { deps } = harness({
      resolveChosenModel: async () => ({
        provider: "openai",
        model: "glm-5.3-flash",
        source: "choice: token::glm-5.3-flash",
      }),
      needsRestart: () => true,
      // The port answers throughout: that is exactly the case the old code adopted as "done".
      healthy: async () => true,
      startDaemon: (_model, opts) => {
        started = opts;
      },
    });
    const status = await runSetup(deps);
    expect(started).toEqual({ restart: true });
    expect(status.phase).toBe("ok");
    expect(status.steps.find((step) => step.id === "service")?.detail).toContain("restarted");
  });

  it("installs uv when it is missing, and continues when that works", async () => {
    let installed = 0;
    let present = false;
    const { deps } = harness({
      hasUvx: () => present,
      installUv: async () => {
        installed += 1;
        present = true;
        return { ok: true, detail: "installed uv 0.9" };
      },
      healthy: async () => true,
    });
    const status = await runSetup(deps);
    expect(installed).toBe(1);
    expect(status.phase).toBe("ok");
    expect(status.steps.find((step) => step.id === "uv")?.detail).toBe("installed");
  });

  it("fails with a reason the page can act on when uv cannot be installed", async () => {
    const { deps } = harness({
      hasUvx: () => false,
      installUv: async () => ({ ok: false, detail: "curl: (7) Failed to connect" }),
    });
    const status = await runSetup(deps);
    expect(status.phase).toBe("failed");
    expect(status.code).toBe("uv-missing");
    expect(status.detail).toContain("Failed to connect");
    // Nothing after uv runs: there is no point choosing a model for a runtime that cannot start.
    expect(status.steps.map((step) => step.id)).toEqual(["uv"]);
  });

  it("names the missing model instead of starting a server that would die on its first request", async () => {
    let started = 0;
    const { deps } = harness({
      resolveHarnessModel: async () => undefined,
      startDaemon: () => {
        started += 1;
      },
    });
    const status = await runSetup(deps);
    expect(status.code).toBe("model-missing");
    expect(started).toBe(0);
  });

  it("prefers the page's pick over the environment, and the environment over dsh", async () => {
    // Asserted on the reported result rather than on the spawn: an already-healthy service is adopted
    // without starting anything, and what the user needs to see is which model won.
    const { deps } = harness({
      settings: { serverMode: "daemon", llmChoice: "token::from-pick" },
      resolveChosenModel: async () => ({ provider: "from-pick", source: "choice" }),
      env: { HINDSIGHT_API_LLM_PROVIDER: "from-env" },
      resolveHarnessModel: async () => ({ provider: "from-harness", source: "dsh" }),
      healthy: async () => true,
    });
    expect((await runSetup(deps)).service?.provider).toBe("from-pick");
  });

  it("falls to dsh's own model when nothing is picked", async () => {
    const { deps } = harness({
      env: { OPENAI_API_KEY: "sk-other-tool" },
      resolveHarnessModel: async () => ({ provider: "from-dsh", source: "llm-pi-ai/token" }),
      healthy: async () => true,
    });
    // Not `openai`: the ambient key belongs to another tool, so this must not spend it.
    expect((await runSetup(deps)).service?.provider).toBe("from-dsh");
  });

  it("uses a model stated for Hindsight itself above dsh's own", async () => {
    const { deps } = harness({
      env: { HINDSIGHT_API_LLM_PROVIDER: "lmstudio", HINDSIGHT_API_LLM_MODEL: "local-7b" },
      resolveHarnessModel: async () => ({ provider: "from-dsh", source: "dsh" }),
      healthy: async () => true,
    });
    const status = await runSetup(deps);
    expect(status.service).toMatchObject({ provider: "lmstudio", model: "local-7b" });
  });

  it("uses the harness route when neither the page nor the environment offers one", async () => {
    let started: DaemonModel | undefined;
    let probes = 0;
    const { deps } = harness({
      resolveHarnessModel: async () => ({ provider: "openai", baseUrl: "https://gw/v1", apiKey: "sk", source: "dsh" }),
      startDaemon: (model) => {
        started = model;
      },
      // The daemon answers from the first probe AFTER the starter ran: the pre-start check fails,
      // the post-start poll succeeds, and the status reaches the success it reports a service for.
      healthy: async () => probes++ > 0,
    });
    const status = await runSetup({ ...deps, waitMs: 1_000 });
    expect(started?.baseUrl).toBe("https://gw/v1");
    expect(status.service?.provider).toBe("openai");
  });

  it("gives up on a service that never answers, and says how long it waited", async () => {
    const { deps } = harness({ healthy: async () => false });
    const status = await runSetup(deps);
    expect(status.code).toBe("unhealthy");
    expect(status.detail).toContain("4s");
    expect(status.steps.at(-1)).toMatchObject({ id: "service", ok: false });
  });

  it("refuses a request that is not about the local service", async () => {
    const { deps } = harness({ settings: { serverMode: "cloud" } });
    const status = await runSetup(deps);
    expect(status.code).toBe("not-daemon");
  });

  it("turns a thrown step into a failure status rather than an unhandled rejection", async () => {
    const { deps } = harness({
      daemonTarget: () => {
        throw new Error("config exploded");
      },
      healthy: async () => true,
    });
    const status = await runSetup(deps);
    expect(status.phase).toBe("failed");
    expect(status.code).toBe("error");
    expect(status.detail).toBe("config exploded");
  });

  it("survives a status write that fails, because reporting must not break the setup", async () => {
    const { deps } = harness({
      publish: () => {
        throw new Error("settings write refused");
      },
      healthy: async () => true,
    });
    const status = await runSetup(deps);
    expect(status.phase).toBe("ok");
  });
});

describe("the status the two halves exchange", () => {
  it("round-trips through the settings document unchanged", () => {
    const status: SetupStatus = {
      at: 1_700_000_000_000,
      phase: "failed",
      code: "model-missing",
      detail: "nothing available",
      steps: [{ id: "uv", ok: true }, { id: "model", ok: false, detail: "none" }],
      elapsedMs: 12,
    };
    expect(parseSetupStatus(serializeSetupStatus(status))).toEqual(status);
  });

  it("reads anything else as no status at all", () => {
    expect(parseSetupStatus("")).toBeUndefined();
    expect(parseSetupStatus("not json")).toBeUndefined();
    expect(parseSetupStatus("{}")).toBeUndefined();
    expect(parseSetupStatus(JSON.stringify({ at: 1, phase: "weird" }))).toBeUndefined();
    expect(parseSetupStatus(undefined)).toBeUndefined();
  });

  it("drops a code or step the page has no localization key for, keeping the rest", () => {
    // A newer host may write a code this page predates; the page localizes through fixed keys
    // (`setupReason.${code}`), so passing an unknown value through would render a bare key the
    // user cannot read. The phase still says what happened, so only the unmappable member goes.
    const status = parseSetupStatus(
      JSON.stringify({ at: 1, phase: "failed", code: "quantum-decoherence", step: "warp", detail: "boom" })
    );
    expect(status).toBeDefined();
    expect(status?.phase).toBe("failed");
    expect(status?.code).toBeUndefined();
    expect(status?.step).toBeUndefined();
    expect(status?.detail).toBe("boom");
    // A code the page DOES know survives.
    const known = parseSetupStatus(JSON.stringify({ at: 1, phase: "failed", code: "uv-missing" }));
    expect(known?.code).toBe("uv-missing");
  });
});
