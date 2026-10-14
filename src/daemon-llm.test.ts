import { describe, expect, it } from "vitest";
import { applyDaemonLlmEnv, DAEMON_LLM_ENV } from "./daemon-llm";
import { SECRET_FIELD, type DshSettings } from "./fields";
import { DEFAULT_SETTINGS } from "./fields";
import type { DaemonModel } from "./setup";

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

// Keep the type referenced so the import stays meaningful for the shape under test.
const _settings: DshSettings | undefined = undefined;
