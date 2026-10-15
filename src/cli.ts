/**
 * `hindsight-dsh` — the same reports as `/hindsight`, from a shell.
 *
 * Why it exists next to the command: the questions this answers get asked when something is WRONG,
 * and the dsh that would run the command is sometimes the thing that is wrong (a plugin that
 * failed to bind, a client half that never loaded). A CLI resolves the config from the same files
 * the plugin reads and talks to the same daemon, so it can be run when dsh cannot.
 *
 * It reads config exactly like the plugin does — `loadConfig` under the `dsh` harness id, plus the
 * `HINDSIGHT_HOST_OVERRIDES` layer a running host exports — and nothing here writes: every call is
 * a GET, and a token is never printed.
 */
import { resolve } from "node:path";
import { resolveHostMemory } from "../vendor/coding-agents/src/core/host-client";
import { syncStatus } from "../vendor/coding-agents/src/core/status";
import { HARNESS } from "./harness";
import {
  HELP_TEXT,
  collectInspect,
  createInspectApi,
  formatInspect,
  parseInspectInput,
  type InspectDeps,
  type InspectRequest,
} from "./inspect";

interface Args {
  json: boolean;
  help: boolean;
  cwd: string;
  request: InspectRequest;
}

/** Read the argv. Positional words are the command; the flags surround them. */
function parseArgs(argv: string[]): Args {
  let json = false;
  let help = false;
  let cwd = process.cwd();
  const words: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") json = true;
    else if (arg === "--help" || arg === "-h") help = true;
    else if (arg === "--cwd") {
      const next = argv[++i];
      if (next === undefined) throw new Error("--cwd needs a directory");
      cwd = next;
    } else if (arg !== undefined) words.push(arg);
  }
  return { json, help, cwd, request: parseInspectInput(words.join(" ")) };
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.request.kind === "help") {
    console.log(HELP_TEXT);
    return 0;
  }
  if (args.request.kind === "invalid") {
    // An empty `word` is a subcommand with nothing after it — see the command's own wording.
    const problem = args.request.word === "" ? "missing an argument" : `unknown option "${args.request.word}"`;
    console.error(`hindsight-dsh: ${problem}\n\n${HELP_TEXT}`);
    return 2;
  }

  const directory = resolve(args.cwd);
  // Config, bank and client come from the runtime's own resolver, so the CLI answers about the same
  // bank a session in that directory would write to — including `paths.<prefix>`, `banks.<id>` and
  // the `optInOnly` rules. Building it sends nothing.
  const memory = resolveHostMemory(HARNESS, directory);
  const deps: InspectDeps = {
    api: createInspectApi(memory.client),
    cfg: memory.cfg,
    directory,
    bankId: memory.bankId,
    // Only a resolved bank has documents to summarise; a disabled or opted-out directory has none.
    ...(memory.bankId === ""
      ? {}
      : { sync: () => syncStatus(memory.client, memory.bankId, directory) }),
  };

  const data = await collectInspect(deps, args.request);
  if (data === null) {
    console.log(HELP_TEXT);
    return 0;
  }
  console.log(args.json ? JSON.stringify(data, null, 2) : formatInspect(data));
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    // The endpoint is worth naming on a refusal: a 401 means the token, an ECONNREFUSED means the
    // local service is not up (`~/.hindsight/profiles/coding-agent.log` says why).
    console.error(`hindsight-dsh: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  },
);
