/**
 * The human-facing `/hindsight` command.
 *
 * dsh's command registry (`@deepseek-ai/dsh-commands`) runs a slash command against an agent
 * WITHOUT creating a model message: the result is rendered by the client outside model history, and
 * the session log keeps a `command/run` / `command/done` pair. That is exactly the shape a
 * debugging aid wants — asking "what has this project recorded?" must not cost a turn, and must not
 * end up in the context the model reasons over.
 *
 * A plain registration is GLOBAL, so this works from the profile-level row: no preset has to name
 * this plugin, and the command is available in the Web client and the CLI alike.
 */
import { log } from "../vendor/coding-agents/src/core/log";
import { HARNESS } from "./harness";
import { HELP_TEXT, parseInspectInput, runInspect, type InspectDeps } from "./inspect";

/** The command registry, as this plugin uses it (structural: no dsh package is imported). */
export interface CommandsLike {
  register(definition: {
    name: string;
    description: string;
    input?: { hint: string; attachments?: boolean };
    handler: (invocation: HindsightInvocation) => unknown;
  }): unknown;
}

/** The one scope dsh hands the plugin; absent on a composition without a command surface. */
export interface CommandScope {
  commands?: CommandsLike;
}

/** What a command handler is called with, to the extent this plugin reads it. */
export interface HindsightInvocation {
  agent?: unknown;
  rawInput?: unknown;
}

export interface CommandDeps {
  /** The directory the asking agent works in — its session's cwd. */
  directoryOf(agent: unknown): string;
  /** Everything a report needs for one directory, resolved at CALL time: the page may have been
   *  saved a second ago, and the config reference it wrote is the one in force now. */
  inspectFor(directory: string): InspectDeps;
}

/** The command's name and discovery copy, shared with the README and the tests. */
export const COMMAND_NAME = "hindsight";
export const COMMAND_DESCRIPTION = "This project's Hindsight memory: banks, records, logs";
export const COMMAND_HINT = "[banks|bank <bank_id>|documents <bank_id>|doctor|help]";

/**
 * Register `/hindsight` on a command scope.
 *
 * @returns whether this instance owns the registration. A composition without the registry, or one
 * where another instance already registered the name, returns false — see the catch below.
 */
export function registerHindsightCommand(scope: CommandScope, deps: CommandDeps): boolean {
  const commands = scope.commands;
  if (typeof commands?.register !== "function") {
    log.debug(HARNESS, "no command registry in this composition");
    return false;
  }

  const handler = async (invocation: HindsightInvocation): Promise<{ kind: "success" | "error"; text: string }> => {
    const rawInput = typeof invocation?.rawInput === "string" ? invocation.rawInput : "";
    const request = parseInspectInput(rawInput);
    if (request.kind === "help") return { kind: "success", text: HELP_TEXT };
    if (request.kind === "invalid") {
      // An empty `word` is a subcommand with nothing after it — a different mistake from a typo, and
      // "unknown option \"\"" would read like a bug in the command rather than in the input.
      const problem = request.word === "" ? "missing an argument" : `unknown option "${request.word}"`;
      return { kind: "error", text: `hindsight: ${problem}\n\n${HELP_TEXT}` };
    }
    try {
      const directory = deps.directoryOf(invocation?.agent);
      return { kind: "success", text: await runInspect(deps.inspectFor(directory), request) };
    } catch (error) {
      // A report that throws must still say something useful: the UI shows this text and nothing
      // else, and the failure IS the diagnosis half the time.
      return { kind: "error", text: `hindsight: ${error instanceof Error ? error.message : String(error)}` };
    }
  };

  try {
    commands.register({
      name: COMMAND_NAME,
      description: COMMAND_DESCRIPTION,
      input: { hint: COMMAND_HINT },
      handler,
    });
    // One line per process, next to the bind line: "is the command there?" is otherwise only
    // answerable from inside a session, which is the thing a broken plugin cannot give you.
    log.info(HARNESS, "hindsight command registered", { name: COMMAND_NAME });
    return true;
  } catch (error) {
    // The registry refuses a second registration of the same name in one scope, and a persistent
    // host mounts this plugin once per preset composition: the first instance owns the global
    // command and every other one has to step aside. Failing here would fail a bind over a
    // convenience, so it is a debug line rather than an error.
    log.debug(HARNESS, "hindsight command already registered", {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
