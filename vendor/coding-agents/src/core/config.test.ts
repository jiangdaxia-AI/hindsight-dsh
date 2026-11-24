/**
 * The `banks.<id>` section's connection overrides, through `applyBankConfig`.
 *
 * The one defect class worth a file of its own: `apiUrl` is DERIVED from `serverMode` + `apiPort`,
 * so a bank section naming only `serverMode` re-derives the URL too. The old derivation keyed on
 * the GLOBAL cfg's mode, and a global daemon mode meant `cfg.apiUrl` was dropped as "derived" —
 * which resolved a bank that said only `{ "serverMode": "self-hosted" }` onto the CLOUD default,
 * silently repointing that bank's memory at a different service. The derivation now keeps the
 * effective URL unless the patch itself moves to daemon, where the port is the truth instead.
 */
import { describe, expect, it } from "vitest";
import { applyBankConfig, loadConfig, type Config } from "./config";

/** A daemon-mode global config, as a settings page that picked the local service resolves to. */
function daemonGlobal(overrides: Record<string, unknown> = {}): Config {
  return loadConfig({
    // An empty path layer keeps the file out of the test; the object below is the whole config.
    path: "/nonexistent-hs-config-test/coding-agent.json",
    overrides: { serverMode: "daemon", apiPort: 9077, ...overrides },
  });
}

describe("a banks.<id> section's connection overrides", () => {
  it("moves a bank to self-hosted without dropping the effective URL onto the Cloud default", () => {
    const global = daemonGlobal();
    expect(global.apiUrl).toBe("http://127.0.0.1:9077"); // daemon mode derives it from the port
    const { cfg } = applyBankConfig(global, "coding-agent::x", "/repo/x");
    expect(cfg.apiUrl).toBe("http://127.0.0.1:9077"); // no bank section: unchanged
  });

  it("resolves a bank section naming only a serverMode against the effective URL, not Cloud", () => {
    // The regression: `{"banks":{"coding-agent::x":{"serverMode":"self-hosted"}}}` under a global
    // daemon mode used to yield the CLOUD default URL for that bank.
    const global = daemonGlobal({
      banks: { "coding-agent::x": { serverMode: "self-hosted" } },
    });
    const { cfg } = applyBankConfig(global, "coding-agent::x", "/repo/x");
    expect(cfg.serverMode).toBe("self-hosted");
    // Not https://api.hindsight.vectorize.io: the URL the process actually had stays in force.
    expect(cfg.apiUrl).toBe("http://127.0.0.1:9077");
  });

  it("still re-derives the loopback URL when the bank section asks for daemon by name", () => {
    const global = daemonGlobal({
      apiUrl: "https://self-hosted.example",
      serverMode: "self-hosted",
      banks: { "coding-agent::x": { serverMode: "daemon", apiPort: 9078 } },
    });
    const { cfg } = applyBankConfig(global, "coding-agent::x", "/repo/x");
    expect(cfg.serverMode).toBe("daemon");
    expect(cfg.apiUrl).toBe("http://127.0.0.1:9078");
  });
});
