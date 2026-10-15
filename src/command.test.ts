import { describe, expect, it } from "vitest";
import type { Config } from "../vendor/coding-agents/src/core/config";
import {
  COMMAND_DESCRIPTION,
  COMMAND_HINT,
  COMMAND_NAME,
  registerHindsightCommand,
  type CommandsLike,
  type HindsightInvocation,
} from "./command";
import type { InspectApi, InspectDeps } from "./inspect";

const BANK = { bankId: "coding-agent::repo", factCount: 12, lastWriteAt: "2026-10-14T07:01:44.000Z" };

function stubApi(): InspectApi {
  return {
    banks: async () => ({ total: 1, banks: [BANK] }),
    documentCount: async () => 2,
    documents: async () => ({ total: 1, items: [{ id: "gitlog:repo", tags: ["source:git"] }] }),
    pages: async () => ["Component map"],
    activeOperations: async () => 0,
    health: async () => true,
  };
}

function deps(): InspectDeps {
  return {
    api: stubApi(),
    cfg: { apiUrl: "http://127.0.0.1:9077", serverMode: "daemon", disabled: false } as unknown as Config,
    directory: "/tmp/repo",
    bankId: BANK.bankId,
  };
}

/** A command registry that records what was registered, like the real one. */
function stubRegistry(): {
  commands: CommandsLike;
  registered: Array<{ name: string; description: string; hint?: string }>;
  run(input: string, agent?: unknown): Promise<{ kind: string; text: string }>;
} {
  const registered: Array<{ name: string; description: string; hint?: string }> = [];
  let handler: ((invocation: HindsightInvocation) => unknown) | undefined;
  return {
    registered,
    commands: {
      register(definition) {
        registered.push({ name: definition.name, description: definition.description, hint: definition.input?.hint });
        handler = definition.handler;
      },
    },
    async run(input, agent) {
      const out = (await handler?.({ rawInput: input, agent })) as { kind: string; text: string };
      return out;
    },
  };
}

describe("the /hindsight command", () => {
  it("registers the name, discovery copy and hint the client menu shows", () => {
    const registry = stubRegistry();
    const registered = registerHindsightCommand({ commands: registry.commands }, {
      directoryOf: () => "/tmp/repo",
      inspectFor: () => deps(),
    });
    expect(registered).toBe(true);
    expect(registry.registered).toEqual([
      { name: COMMAND_NAME, description: COMMAND_DESCRIPTION, hint: COMMAND_HINT },
    ]);
    expect(COMMAND_NAME).toBe("hindsight");
    // The name has to be a legal command: lowercase, no slashes, nothing the parser rejects.
    expect(COMMAND_NAME).toMatch(/^[a-z][a-z0-9_-]*$/);
  });

  it("answers with the report for the ASKING agent's directory", async () => {
    const registry = stubRegistry();
    const seen: string[] = [];
    registerHindsightCommand(
      { commands: registry.commands },
      {
        directoryOf: (agent) => {
          const directory = `/${String((agent as { repo?: string })?.repo ?? "unknown")}`;
          seen.push(directory);
          return directory;
        },
        inspectFor: () => deps(),
      },
    );
    const out = await registry.run("banks", { repo: "some-repo" });
    expect(out.kind).toBe("success");
    expect(out.text).toContain("coding-agent::repo");
    expect(seen).toEqual(["/some-repo"]);
  });

  it("answers the default (no arguments) with the overview", async () => {
    const registry = stubRegistry();
    registerHindsightCommand({ commands: registry.commands }, { directoryOf: () => "/tmp/repo", inspectFor: () => deps() });
    const out = await registry.run("");
    expect(out.kind).toBe("success");
    expect(out.text).toContain("hindsight · dsh memory");
  });

  it("lists a bank's documents, with the flags the command's own grammar carries", async () => {
    const registry = stubRegistry();
    registerHindsightCommand({ commands: registry.commands }, { directoryOf: () => "/tmp/repo", inspectFor: () => deps() });
    const out = await registry.run("documents coding-agent::repo --limit 5 --tags source:git");
    expect(out.kind).toBe("success");
    expect(out.text).toContain("Hindsight documents · coding-agent::repo");
    expect(out.text).toContain("tags source:git (all)");
    expect(out.text).toContain("gitlog:repo");
  });

  it("turns a bad argument into an error that carries the usage", async () => {
    const registry = stubRegistry();
    registerHindsightCommand({ commands: registry.commands }, { directoryOf: () => "/tmp/repo", inspectFor: () => deps() });
    const out = await registry.run("teleport");
    expect(out.kind).toBe("error");
    expect(out.text).toContain('unknown option "teleport"');
    expect(out.text).toContain("/hindsight banks [--all]");
  });

  it("calls a subcommand with nothing after it 'missing an argument', not an unknown option", async () => {
    const registry = stubRegistry();
    registerHindsightCommand({ commands: registry.commands }, { directoryOf: () => "/tmp/repo", inspectFor: () => deps() });
    const out = await registry.run("documents");
    expect(out.kind).toBe("error");
    expect(out.text).toContain("hindsight: missing an argument");
    expect(out.text).not.toContain('unknown option ""');
  });

  it("reports a failed report as an error instead of throwing at the UI", async () => {
    const registry = stubRegistry();
    registerHindsightCommand(
      { commands: registry.commands },
      {
        directoryOf: () => "/tmp/repo",
        inspectFor: () => ({
          ...deps(),
          api: {
            ...stubApi(),
            banks: async () => {
              throw new Error("ECONNREFUSED");
            },
          },
        }),
      },
    );
    const out = await registry.run("banks");
    expect(out.kind).toBe("error");
    expect(out.text).toContain("ECONNREFUSED");
  });

  it("steps aside when the name is already registered, rather than failing a bind", () => {
    // A persistent host mounts the plugin once per preset composition: the first instance owns the
    // global command, and the registry throws for every later one.
    const commands: CommandsLike = {
      register() {
        throw new Error('command "hindsight" is already registered (for a per-agent variant, ...)');
      },
    };
    expect(() =>
      registerHindsightCommand({ commands }, { directoryOf: () => "/tmp", inspectFor: () => deps() }),
    ).not.toThrow();
    expect(registerHindsightCommand({ commands }, { directoryOf: () => "/tmp", inspectFor: () => deps() })).toBe(false);
  });

  it("does nothing in a composition without a command surface", () => {
    expect(registerHindsightCommand({}, { directoryOf: () => "/tmp", inspectFor: () => deps() })).toBe(false);
    expect(
      registerHindsightCommand({ commands: {} as CommandsLike }, { directoryOf: () => "/tmp", inspectFor: () => deps() }),
    ).toBe(false);
  });
});
