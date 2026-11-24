/**
 * The `daemonEnv` LLM fallback — the guess must not overrule the statement.
 *
 * The regression this pins (2026-10-16, from the review of the model-persistence fix): a provider
 * was stated explicitly (the dsh settings page writes exactly these variables for a keyless local
 * gateway) while some OTHER tool's credential sat in the environment. `detectLlm`'s ambient probe
 * happily offered that key, and `daemonEnv` filled it in — sending a gateway that needed no
 * credential one belonging to a different provider, so the request failed auth on a route that was
 * open before the plugin "helped".
 */
import { describe, expect, it } from "vitest";
import { daemonEnv } from "./daemon";
import type { Config } from "./config";

/** One config that asks for no idle-timeout forwarding, so the LLM entries are the whole answer. */
const cfg = {} as Pick<Config, "daemonIdleTimeout"> as Config;

describe("daemonEnv's ambient LLM probe", () => {
  it("does not fill a key from another provider when one provider was stated", () => {
    const env = {
      HINDSIGHT_API_LLM_PROVIDER: "glm",
      HINDSIGHT_API_LLM_BASE_URL: "http://127.0.0.1:8888/v1",
      OPENAI_API_KEY: "sk-openai-not-mine",
    } as NodeJS.ProcessEnv;
    const out = daemonEnv(cfg, env);
    expect(out.HINDSIGHT_API_LLM_PROVIDER).toBe("glm");
    expect(out.HINDSIGHT_API_LLM_API_KEY).toBeUndefined();
  });

  it("still fills the key when the probe agrees with the stated provider", () => {
    const env = {
      HINDSIGHT_API_LLM_PROVIDER: "openai",
      OPENAI_API_KEY: "sk-openai",
    } as NodeJS.ProcessEnv;
    const out = daemonEnv(cfg, env);
    expect(out.HINDSIGHT_API_LLM_API_KEY).toBe("sk-openai");
  });

  it("still guesses both halves when nothing was stated", () => {
    const env = { ANTHROPIC_API_KEY: "sk-anthropic" } as NodeJS.ProcessEnv;
    const out = daemonEnv(cfg, env);
    expect(out.HINDSIGHT_API_LLM_PROVIDER).toBe("anthropic");
    expect(out.HINDSIGHT_API_LLM_API_KEY).toBe("sk-anthropic");
  });
});
