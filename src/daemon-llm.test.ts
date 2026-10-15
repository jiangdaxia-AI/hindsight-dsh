import { describe, expect, it } from "vitest";
import {
  applyDaemonLlmEnv,
  DAEMON_LLM_ENV,
  DAEMON_PROCESS_ENV,
  ensureDaemonProcessEnv,
  installDaemonLlmEnv,
  resetDaemonLlmInstallForTest,
} from "./daemon-llm";
import { SECRET_FIELD, type DshSettings } from "./fields";
import { DEFAULT_SETTINGS } from "./fields";
import type { DaemonModel } from "./setup";

/** One resolved model, for the install tests that do not care about its fields. */
const model = (over: Partial<DaemonModel> = {}): DaemonModel => ({
  provider: "deepseek",
  baseUrl: "https://gateway.example/v1",
  model: "deepseek-chat",
  apiKey: "sk-test",
  source: "test",
  ...over,
});

describe("daemon LLM environment", () => {
  it("writes the resolved model's four values, under the server's own names", () => {
    const env = {} as NodeJS.ProcessEnv;
    const model: DaemonModel = {
      provider: "deepseek",
      baseUrl: "https://gateway.example/v1",
      model: "deepseek-chat",
      apiKey: "sk-test",
      source: "test",
    };
    const written = applyDaemonLlmEnv(model, env);
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe("deepseek");
    expect(env.HINDSIGHT_API_LLM_BASE_URL).toBe("https://gateway.example/v1");
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
    expect(env.HINDSIGHT_API_LLM_API_KEY).toBe("sk-test");
    // The key is reported as present, never echoed — this object can reach a log line.
    expect(written.HINDSIGHT_API_LLM_API_KEY).toBe("set");
    expect(written.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
  });

  it("writes only what the model carries, leaving the rest of the environment alone", () => {
    const env = { HINDSIGHT_API_LLM_MODEL: "already-here" } as NodeJS.ProcessEnv;
    const written = applyDaemonLlmEnv({ provider: "deepseek", model: "deepseek-chat", source: "test" }, env);
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe("deepseek");
    expect("HINDSIGHT_API_LLM_API_KEY" in env).toBe(false);
    expect(written.HINDSIGHT_API_LLM_API_KEY).toBeUndefined();
  });

  it("writes nothing when no model was resolved", () => {
    const env = { HINDSIGHT_API_LLM_MODEL: "already-here" } as NodeJS.ProcessEnv;
    expect(applyDaemonLlmEnv(undefined, env)).toEqual({});
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("already-here");
  });

  it("keeps the Hindsight token out of the daemon's LLM environment by construction", () => {
    expect(SECRET_FIELD).toBe("apiToken");
    // The only values it can write are a resolved model's own four — there is no settings object
    // for a stray token field to leak from anymore.
    expect(Object.values(DAEMON_LLM_ENV)).not.toContain("HINDSIGHT_API_TOKEN");
    expect(DEFAULT_SETTINGS).toHaveProperty("llmChoice");
    expect(DEFAULT_SETTINGS).toHaveProperty("modelChoices");
  });

  it("describes every field it writes", () => {
    const fields: Array<keyof typeof DAEMON_LLM_ENV> = ["provider", "baseUrl", "model", "apiKey"];
    for (const field of fields) {
      expect(DAEMON_LLM_ENV[field]).toMatch(/^HINDSIGHT_API_LLM_/);
    }
  });
});

describe("installing the daemon model durably", () => {
  // The install tracks what it borrowed in module state, so each test starts from a clean slate.
  it("writes the model where a spawned daemon — and the profile it persists — will read it", () => {
    resetDaemonLlmInstallForTest();
    const env = {} as NodeJS.ProcessEnv;
    const written = installDaemonLlmEnv(model(), env);
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe("deepseek");
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
    expect(written.HINDSIGHT_API_LLM_API_KEY).toBe("set");
  });

  it("replaces a previous install rather than layering on top of it", () => {
    resetDaemonLlmInstallForTest();
    const env = {} as NodeJS.ProcessEnv;
    installDaemonLlmEnv(model({ provider: "glm", model: "glm-4.6" }), env);
    installDaemonLlmEnv(model({ provider: "deepseek", model: "deepseek-chat", apiKey: undefined }), env);
    // The second model carries no key; the first install's key must not survive it.
    expect(env.HINDSIGHT_API_LLM_PROVIDER).toBe("deepseek");
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
    expect("HINDSIGHT_API_LLM_API_KEY" in env).toBe(false);
  });

  it("puts the user's own export back when an install is replaced or cleared", () => {
    resetDaemonLlmInstallForTest();
    const env = { HINDSIGHT_API_LLM_MODEL: "user-exported" } as NodeJS.ProcessEnv;
    installDaemonLlmEnv(model(), env);
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("deepseek-chat");
    // The pick goes away — the exported value comes back, not a hole.
    installDaemonLlmEnv(undefined, env);
    expect(env.HINDSIGHT_API_LLM_MODEL).toBe("user-exported");
  });

  it("removes what it added when the environment was silent before", () => {
    resetDaemonLlmInstallForTest();
    const env = {} as NodeJS.ProcessEnv;
    installDaemonLlmEnv(model(), env);
    installDaemonLlmEnv(undefined, env);
    expect("HINDSIGHT_API_LLM_PROVIDER" in env).toBe(false);
    expect("HINDSIGHT_API_LLM_BASE_URL" in env).toBe(false);
    expect("HINDSIGHT_API_LLM_MODEL" in env).toBe(false);
    expect("HINDSIGHT_API_LLM_API_KEY" in env).toBe(false);
  });
});

describe("the daemon's process environment", () => {
  // The stub stands in for `scutil --proxy`: no exec, a fixed answer, no macOS requirement.
  const proxyStub = (facts: string) => (_cmd: string, _args: string[]) =>
    Promise.resolve({ stdout: facts });
  const macOSProxy = proxyStub(
    "<dictionary> { HTTPEnable : 1 HTTPProxy : 127.0.0.1 HTTPPort : 10808 HTTPSEnable : 1 " +
      "HTTPSProxy : 127.0.0.1 HTTPSPort : 10808 }"
  );
  /** The arguments `readSystemProxy` passes its exec, for asserting it asked the right question. */
  const execRecorder = (stdout: string) => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    return {
      calls,
      exec: (cmd: string, args: string[]) => {
        calls.push({ cmd, args });
        return Promise.resolve({ stdout });
      },
    };
  };

  it("mirrors the system proxy before exempting the loopback, because NO_PROXY alone kills the fallback", async () => {
    // The regression this pins: setting NO_PROXY without HTTP(S)_PROXY switches Python's proxy
    // resolution from "system configuration" to "environment only" — the daemon goes direct, and
    // on a machine whose only route out is the system proxy it cannot even reach the model hub.
    const env = {} as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "darwin", macOSProxy);
    expect(env[DAEMON_PROCESS_ENV.httpsProxy]).toBe("http://127.0.0.1:10808");
    expect(env[DAEMON_PROCESS_ENV.httpsProxyLower]).toBe("http://127.0.0.1:10808");
    expect(env[DAEMON_PROCESS_ENV.noProxy]).toBe("127.0.0.1,localhost");
    expect(env[DAEMON_PROCESS_ENV.noProxyLower]).toBe("127.0.0.1,localhost");
    expect(env[DAEMON_PROCESS_ENV.startupTimeout]).toBe("300");
  });

  it("reads the proxy from scutil, with the one query macOS documents", async () => {
    const { exec, calls } = execRecorder("HTTPEnable : 1 HTTPProxy : 10.0.0.2 HTTPPort : 3128");
    const env = {} as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "darwin", exec);
    expect(calls).toEqual([{ cmd: "scutil", args: ["--proxy"] }]);
    expect(env[DAEMON_PROCESS_ENV.httpProxy]).toBe("http://10.0.0.2:3128");
  });

  it("never mirrors onto a proxy the user already exported", async () => {
    const env = { HTTP_PROXY: "http://user-proxy:8080" } as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "darwin", macOSProxy);
    expect(env[DAEMON_PROCESS_ENV.httpProxy]).toBe("http://user-proxy:8080");
    expect(env[DAEMON_PROCESS_ENV.httpsProxy]).toBeUndefined();
  });

  it("skips a disabled system proxy entirely, writing only the exemption and the budget", async () => {
    const env = {} as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "darwin", proxyStub("<dictionary> { HTTPEnable : 0 }"));
    expect(env[DAEMON_PROCESS_ENV.httpProxy]).toBeUndefined();
    expect(env[DAEMON_PROCESS_ENV.noProxy]).toBe("127.0.0.1,localhost");
  });

  it("does not exec anything off macOS, where there is no scutil to ask", async () => {
    const { exec, calls } = execRecorder("HTTPEnable : 1");
    const env = {} as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "linux", exec);
    expect(calls).toEqual([]);
    expect(env[DAEMON_PROCESS_ENV.httpProxy]).toBeUndefined();
    expect(env[DAEMON_PROCESS_ENV.noProxy]).toBe("127.0.0.1,localhost");
  });

  it("never argues with an environment that already spoke", async () => {
    const env = {
      HTTP_PROXY: "http://user-proxy:8080",
      [DAEMON_PROCESS_ENV.noProxy]: "127.0.0.1,localhost,10.0.0.0/8",
      [DAEMON_PROCESS_ENV.noProxyLower]: "127.0.0.1",
      [DAEMON_PROCESS_ENV.startupTimeout]: "600",
    } as NodeJS.ProcessEnv;
    expect(await ensureDaemonProcessEnv(env, "darwin", macOSProxy)).toBeUndefined();
    expect(env[DAEMON_PROCESS_ENV.noProxy]).toBe("127.0.0.1,localhost,10.0.0.0/8");
    expect(env[DAEMON_PROCESS_ENV.startupTimeout]).toBe("600");
  });

  it("appends the loopback to a user exemption that lacks it, keeping theirs", async () => {
    const env = { [DAEMON_PROCESS_ENV.noProxy]: "example.test" } as NodeJS.ProcessEnv;
    await ensureDaemonProcessEnv(env, "darwin", macOSProxy);
    expect(env[DAEMON_PROCESS_ENV.noProxy]).toBe("example.test,127.0.0.1,localhost");
  });
});

// Keep the type referenced so the import stays meaningful for the shape under test.
const _settings: DshSettings | undefined = undefined;
