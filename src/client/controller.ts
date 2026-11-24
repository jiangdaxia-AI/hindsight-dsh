/**
 * The settings page's state machine, with no React in it.
 *
 * Two kinds of control meet here. Text, number and secret fields go through the host's
 * `SettingsFormModel`, which owns staging, the override badge, revision fences and the write order.
 * Switches and selects have no descriptor of that kind in the shipped UI library — there is no
 * `settingsSwitchField`, and inventing one would depend on an API that does not exist — so they are
 * staged HERE, in one map keyed by field name, and committed by the same Save button as one atomic
 * mutation. The projection below flattens both into the single snapshot the component renders, which
 * is also what makes `dirty` account for either kind.
 */
import {
  type FieldState,
  type FormShell,
  SettingsFormModel,
  settingsNumberField,
  settingsTextField,
  type SettingsOp,
  type SettingsScope,
  type SnapshotStore,
} from "@deepseek-ai/dsh-client-ui-primitives";
import { DEFAULT_SETTINGS, NAMESPACE, SECRET_FIELD, llmChoiceKey, parseLlmChoice } from "../fields";
import {
  LIBRARY_CLIENT_ROUTE,
  parseLibrariesResponse,
  type LibrariesResponse,
  type LibraryRow,
} from "../library-contract";
import { parseSetupStatus, type SetupStatus } from "../setup-types";

/** One row of the shared settings-describe mirror, as the browser receives it. */
interface DescribeRow {
  ns?: string;
  /** Presence markers for `role('secret')` fields: the literal never crosses the wire. */
  secrets?: Array<{ path?: unknown; set?: unknown }>;
}

/**
 * What the library list is showing right now.
 *
 * `unavailable` is deliberately its own state rather than another error line: it is what a page from
 * this build sees against a host half from the previous one (whose connection service has no such
 * route), and the two call for different words — one says "restart", the other says "retry".
 */
export interface LibrariesState {
  status: "idle" | "loading" | "ready" | "unavailable" | "error";
  rows: LibraryRow[];
  /** Why the last attempt failed, when it did. */
  error: string | undefined;
  /** The server the last successful listing came from. */
  endpoint: string | undefined;
  /** Whether banks this integration did not create are included. */
  all: boolean;
  /** How many banks the listing left out because `all` is false. */
  hidden: number;
  /** The bank a delete is being confirmed for; the confirmation is open while this is set. */
  confirming: string | undefined;
  /** The bank a delete is in flight for, so its own button can show that and not others. */
  deleting: string | undefined;
  /**
   * The name of the bank just removed, so the card can say the action landed.
   *
   * The LABEL rather than the id: by the time this is shown the row is gone from the listing, so
   * there is nothing left to look the name up in.
   */
  removedLabel: string | undefined;
}

/** The mirror face `ctx.configForms.describe()` returns. */
interface DescribeMirror {
  getSnapshot(): { view?: { namespaces?: DescribeRow[] } };
  subscribe(listener: () => void): () => void;
}

/** The slice of the browser plugin context this page needs. */
export interface CardContext {
  configForms: {
    get(namespace: string): SettingsScope;
    describe?(): DescribeMirror;
  };
}

/** Everything the section component renders, in one snapshot. */
export interface CardState extends FormShell {
  serverMode: string;
  autoInject: string;
  rehydrateMode: string;
  logLevel: string;
  enabled: boolean;
  retainSessions: boolean;
  compactionAware: boolean;
  codeFactEnabled: boolean;
  autoSeed: boolean;
  optInOnly: boolean;
  apiUrl: FieldState;
  apiPort: FieldState;
  uvDir: FieldState;
  bankId: FieldState;
  bankIdTemplate: FieldState;
  apiToken: FieldState;
  /** Which of dsh's models the daemon uses: "" follows dsh, otherwise "route::model". */
  llmChoice: string;
  /** The choices the host half published, empty when it could not read dsh's configuration. */
  llmChoices: Array<{ route: string; model: string }>;
  /** True when the stored choice names a model the host no longer offers. */
  llmChoiceStale: boolean;
  /** The host half's last one-click setup result, or undefined while it has never run. */
  setup: SetupStatus | undefined;
  /** True between this page asking for a setup and the host half saying anything about it. */
  setupPending: boolean;
  /** True when that request got no answer at all — the host half is not there to do the work. */
  setupUnanswered: boolean;
  /**
   * True when the request could not even be written.
   *
   * The upgrade path, and the reason this is a state instead of a swallowed error: a page from a
   * newer build talks to a host half still running the older Config schema, which has no
   * `setupRequest` field and refuses the write. Nothing is pending, nothing will answer, and the
   * only fix is a restart — so the page has to say so.
   */
  setupUnavailable: boolean;
  /** When the request was made, on this page's clock, so the card can count the wait. */
  setupStartedAt: number | undefined;
  apiTokenConfigured: boolean;
  /** False while the Host has not said: the controls then avoid claiming either state. */
  apiTokenKnown: boolean;
  /** The project libraries on the server, and the state of the one action that removes one. */
  libraries: LibrariesState;
}

/** Booleans and enums, whose values are plain scalars this page stages itself. */
const STAGED_FIELDS = [
  "serverMode",
  "autoInject",
  "rehydrateMode",
  "logLevel",
  "llmChoice",
  "enabled",
  "retainSessions",
  "compactionAware",
  "codeFactEnabled",
  "autoSeed",
  "optInOnly",
] as const;

/** Fields the host form model owns, in the order the page shows them. */
const FORM_FIELDS = [
  "apiUrl",
  "apiPort",
  "uvDir",
  "bankId",
  "bankIdTemplate",
] as const;

export class HindsightCardController {
  private readonly form: SettingsFormModel;
  private readonly store: SnapshotStore<CardState>;
  /** Staged values for the fields the form model has no descriptor for. */
  private readonly staged = new Map<string, unknown>();
  private saving = false;
  private failed = false;
  /** When this page last asked for a setup, to tell "not answered yet" from "never asked". */
  private setupRequestedAt: number | undefined;
  /**
   * The timer that ends an unanswered setup claim.
   *
   * `setupUnanswered` is computed from `Date.now()` inside `projection()`, but a projection only
   * runs when something PUBLISHES — and a host that never answers is a host that never publishes
   * again. Without this timer the "not responding" state the page promises could never appear: the
   * snapshot would sit on `setupPending: true` forever, which is exactly the stuck lie the state
   * exists to stop. One timer per request, cancelled when the request resolves.
   */
  private setupAnswerTimer: ReturnType<typeof setTimeout> | undefined;
  /** Set when the host refused the request write itself: an older host half, before a restart. */
  private setupWriteFailed = false;
  /** field -> whether the Host reports a stored value at that secret path. */
  private readonly secretConfigured = new Map<string, boolean>();
  /** Whether the Host sent presence markers at all: absence is not "not configured". */
  private secretKnown = false;
  /** The library list, owned here because it outlives any single render of the card. */
  private readonly libraries: LibrariesState = {
    status: "idle",
    rows: [],
    error: undefined,
    endpoint: undefined,
    all: false,
    hidden: 0,
    confirming: undefined,
    deleting: undefined,
    removedLabel: undefined,
  };
  /** Which library request owns the card; an older answer landing late is dropped. */
  private libraryGeneration = 0;
  private readonly disposers: Array<() => void> = [];

  constructor(
    private readonly scope: SettingsScope,
    private readonly ctx: CardContext
  ) {
    // Read the presence marker BEFORE the first projection: the store is built from one snapshot,
    // and a read that lands after it would leave the token control claiming "not configured" until
    // something else happened to republish.
    const mirror = this.ctx.configForms.describe?.();
    if (mirror) this.readSecretPresence(mirror);
    this.form = new SettingsFormModel(
      scope,
      [
        settingsTextField("apiUrl"),
        settingsNumberField("apiPort"),
        settingsTextField("uvDir"),
        settingsTextField("bankId"),
        settingsTextField("bankIdTemplate"),
      ],
      // The token is never read back to a browser, so it is written through its own callback rather
      // than riding the section write. A blank draft plans no write at all (see the form model's
      // plan), which is exactly "leave the stored token alone".
      [{ field: SECRET_FIELD, write: (text) => this.scope.set(SECRET_FIELD, text) }]
    );
    this.store = this.form.bind(() => this.projection());
    if (mirror) {
      this.disposers.push(
        mirror.subscribe(() => {
          this.readSecretPresence(mirror);
          this.publish();
        })
      );
    }
  }

  /** Release the form's subscription, the mirror subscription, and the unanswered-setup timer. */
  dispose(): void {
    if (this.setupAnswerTimer !== undefined) {
      clearTimeout(this.setupAnswerTimer);
      this.setupAnswerTimer = undefined;
    }
    for (const disposer of this.disposers.splice(0)) disposer();
    this.form.dispose();
  }

  /**
   * Stage one switch or select value.
   *
   * @param field - the settings field the control writes.
   * @param value - the value the user picked.
   */
  stage(field: string, value: unknown): void {
    if (!(STAGED_FIELDS as readonly string[]).includes(field)) return;
    this.staged.set(field, value);
    this.failed = false;
    this.publish();
  }

  /**
   * Ask the host half to prepare the local service.
   *
   * Written through the settings document rather than staged, because a one-click action that then
   * needed a Save click would be two clicks: the request is the click. The same write states the
   * intent, so a request cannot prepare a service the configuration would not use.
   *
   * The nonce is what makes this a request: the host acts on a CHANGED value, and clears it when it
   * accepts, so nothing is left behind in the profile and a retry is a new value.
   *
   * WHAT IT DOES NOT WRITE: `enabled: true` past a switch the user JUST staged off. A click on
   * "prepare the service" is a vote for memory against a SAVED off state, not against a staging
   * that is newer than the click: a user who toggled `enabled` off and then picked a model had
   * that staging silently reverted by the old unconditional write, turning the plugin back on
   * behind their back. `adopted` rides the same mutation: this click is a deliberate act of
   * configuration, which is exactly what that marker means.
   */
  async runSetup(): Promise<void> {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.setupRequestedAt = Date.now();
    this.setupWriteFailed = false;
    this.armSetupAnswerTimer();
    const ops: SettingsOp[] = [
      { op: "set", path: ["serverMode"], value: "daemon" },
      { op: "set", path: ["setupRequest"], value: nonce },
    ];
    // Clicking the setup button is itself the user saying "I want memory", so a SAVED `enabled:
    // false` does not stop the run from turning the switch on — the alternative is a prepared
    // service the configuration then refuses to use. But a SWITCH THE USER JUST STAGED OFF is
    // the newer statement: reverting it silently was exactly the wrong read of this click.
    const mayEnable = this.staged.get("enabled") !== false;
    if (mayEnable) ops.unshift({ op: "set", path: ["enabled"], value: true });
    if (this.scope.getSnapshot().value?.adopted !== true) {
      ops.unshift({ op: "set", path: ["adopted"], value: true });
    }
    // The staged switches would win over the values written here, so drop the ones this writes.
    this.staged.delete("serverMode");
    if (mayEnable) this.staged.delete("enabled");
    this.publish();
    try {
      const landed = await this.scope.mutate(ops);
      // A host half from before this feature has no such field and refuses the write. That is not a
      // failure of the setup but of the upgrade, and it has one remedy: restart the harness.
      if (!landed) {
        this.setupWriteFailed = true;
        this.setupRequestedAt = undefined;
      }
    } catch {
      this.setupWriteFailed = true;
      this.setupRequestedAt = undefined;
    }
    this.publish();
  }

  /**
   * Start (or restart) the timer that publishes the unanswered-setup state.
   *
   * The `stalled` projection is computed from the clock, but a projection only runs on publish —
   * and the whole point of `setupUnanswered` is that the host may never publish again. The timer is
   * what makes the state reachable. It stays armed past the request's own resolution: an ANSWER
   * clears `setupRequestedAt`'s claim through a scope write (a publish), and a REFUSED write does
   * too, so the timer firing after either is a no-op projection, not a wrong one.
   */
  private armSetupAnswerTimer(): void {
    if (this.setupAnswerTimer !== undefined) clearTimeout(this.setupAnswerTimer);
    this.setupAnswerTimer = setTimeout(() => {
      this.setupAnswerTimer = undefined;
      if (this.setupRequestedAt !== undefined) this.publish();
    }, SETUP_ANSWER_TIMEOUT_MS + 50);
  }

  /** The face the slot registration injects into the component. */
  inject() {
    const actions = this.form.actions();
    return {
      hooks: { hindsightCard: this.store },
      edit: actions.edit,
      resetField: actions.resetField,
      // The returned promise is what a test awaits; the slot's `onSave` ignores a value.
      save: (): Promise<void> => this.save(),
      discard: () => {
        this.discard();
      },
      stage: (field: string, value: unknown) => {
        this.stage(field, value);
      },
      runSetup: (): Promise<void> => this.runSetup(),
      refreshLibraries: (all = false): Promise<void> => this.loadLibraries(all),
      askRemove: (bankId: string) => {
        this.askRemove(bankId);
      },
      cancelRemove: () => {
        this.libraries.confirming = undefined;
        this.publish();
      },
      confirmRemove: (): Promise<void> => this.removeConfirmed(),
    };
  }

  /**
   * Load the server's project libraries.
   *
   * A generation counter guards the answer: a refresh clicked while the first request is still in
   * flight must not be overwritten by the older one landing second, which is exactly what a slow
   * first listing plus an impatient second click produces.
   *
   * Refused outright while a delete is in flight: the delete's own answer repaints the list, and a
   * refresh racing it would bump the generation and strand the delete's `deleting`/`confirming`
   * state forever — the old code let the user click "refresh" mid-delete and lock the whole card.
   *
   * @param all - include banks this integration did not create.
   */
  async loadLibraries(all = false): Promise<void> {
    if (this.libraries.deleting !== undefined) return;
    const generation = ++this.libraryGeneration;
    this.libraries.status = "loading";
    this.libraries.error = undefined;
    this.libraries.removedLabel = undefined;
    // OPTIMISTIC, and rolled back on failure below: the toggle button and the hidden count read
    // `all`, so leaving a flipped value behind while the rows on screen are still the OTHER
    // view's would render a list that lies about which question it answers.
    const previousAll = this.libraries.all;
    this.libraries.all = all;
    this.publish();
    const answer = await this.callLibraries("GET", all);
    if (generation !== this.libraryGeneration) return;
    if (answer === undefined || answer.ok !== true) this.libraries.all = previousAll;
    this.applyLibraries(answer);
  }

  /** Open the delete confirmation for one bank. Nothing is sent until it is confirmed. */
  private askRemove(bankId: string): void {
    this.libraries.removedLabel = undefined;
    this.libraries.confirming = bankId;
    this.publish();
  }

  /**
   * Delete the bank the confirmation is open for, then repaint from the answer.
   *
   * The host answers a delete with the listing as it stands AFTER the delete, so one round trip both
   * performs the action and shows its result; a second refresh here would be a second failure point
   * between the user and the truth.
   *
   * The busy state is cleared BEFORE the generation check: whatever else this click raced, the
   * lock itself must always come off, or one lost race strands `deleting`/`confirming` forever and
   * the card can never delete anything again.
   */
  private async removeConfirmed(): Promise<void> {
    const bankId = this.libraries.confirming;
    if (bankId === undefined || this.libraries.deleting !== undefined) return;
    // Captured BEFORE the call: the answer replaces the listing, so afterwards there is no row left
    // to read the name off, and a success notice naming a bare id is worse than none.
    const removedLabel = this.libraries.rows.find((row) => row.bankId === bankId)?.label ?? bankId;
    const generation = ++this.libraryGeneration;
    this.libraries.deleting = bankId;
    this.libraries.error = undefined;
    this.publish();
    const answer = await this.callLibraries("POST", this.libraries.all, { action: "delete", bankId });
    // Unconditional cleanup first: the lock and the dialog must not survive a lost generation.
    this.libraries.deleting = undefined;
    if (generation !== this.libraryGeneration) {
      // A concurrent load won the repaint (a loadLibraries call that slipped in before the guard
      // above, or a generation bump from an earlier in-flight refresh). Its answer is fresher than
      // the delete's would have been, so drop ours — but still close the confirmation dialog: the
      // delete happened (or failed; the repaint says which), and a dialog that cannot be dismissed
      // is a card the user can no longer operate.
      this.libraries.confirming = undefined;
      this.publish();
      return;
    }
    this.libraries.confirming = undefined;
    if (answer?.ok === true) this.libraries.removedLabel = removedLabel;
    this.applyLibraries(answer);
  }

  /**
   * One call against the library route.
   *
   * The BODY decides, not the status: this route answers a refusal it wants the page to read (a
   * delete guard rejection, a malformed request) with its own JSON envelope and a status that says
   * which kind of refusal it was, and the page has to render that reason rather than a number. Only
   * a reply that is NOT this route's envelope is read off the status — and `undefined` there is the
   * 404 of a path that was never registered, which means this page is talking to a host half from
   * before this feature existed (or to a composition with no web transport). That is a restart, not
   * a retry, and the card words it differently — so the distinction is made here, not at the view.
   *
   * @param method - GET to list, POST to act.
   * @param all - whether the listing should include banks of every origin.
   * @param body - the JSON body of a POST.
   */
  private async callLibraries(
    method: "GET" | "POST",
    all: boolean,
    body?: unknown,
  ): Promise<LibrariesResponse | undefined> {
    if (typeof fetch !== "function") return undefined;
    const url = all ? `${LIBRARY_CLIENT_ROUTE}?all=1` : LIBRARY_CLIENT_ROUTE;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        ...(body === undefined
          ? {}
          : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
    } catch (error) {
      return { ok: false, code: "unreachable", error: error instanceof Error ? error.message : String(error) };
    }
    let answer: unknown;
    try {
      answer = await response.json();
    } catch {
      // Not JSON at all: whatever answered, it was not this route's handler.
      return response.status === 404
        ? undefined
        : { ok: false, code: "unreachable", error: `HTTP ${String(response.status)}` };
    }
    const parsed = parseLibrariesResponse(answer);
    // An envelope that parsed but carried no verdict is still this route answering badly; saying so
    // is more useful than "HTTP 200".
    return parsed;
  }

  /** Fold one answer into the card's state. */
  private applyLibraries(answer: LibrariesResponse | undefined): void {
    if (answer === undefined) {
      this.libraries.status = "unavailable";
      this.libraries.error = undefined;
      this.publish();
      return;
    }
    if (!answer.ok) {
      this.libraries.status = "error";
      // A refused delete leaves an intact list on screen: the row is still there, and blanking it
      // would read as "it worked". Only the reason changes.
      this.libraries.error = answer.error;
      this.publish();
      return;
    }
    this.libraries.status = "ready";
    this.libraries.rows = answer.libraries;
    this.libraries.endpoint = answer.endpoint;
    this.libraries.all = answer.all;
    this.libraries.hidden = answer.hidden;
    this.libraries.error = undefined;
    this.publish();
  }

  /**
   * Commit every staged control, then the host form's own staged edits.
   *
   * The staged switches go FIRST, as one atomic mutation: they include the connection mode, and a
   * save that wrote the token after failing to switch modes would leave a credential aimed at an
   * endpoint the user just moved away from.
   */
  private async save(): Promise<void> {
    const snapshot = this.scope.getSnapshot();
    if (this.saving || snapshot.status !== "ready" || !snapshot.writable) return;
    this.saving = true;
    this.failed = false;
    this.publish();
    // The pick is the one control that does not take effect on save: the daemon reads its model
    // from the environment at startup, so only a setup run (which stops and starts it) can apply
    // one. A save that leaves it as "written but not applied" is the report behind the card showing
    // a model the service is not using. Everything else saves as an ordinary field.
    const modelPicked =
      this.staged.has("llmChoice") &&
      this.effective("serverMode") === "daemon" &&
      String(this.staged.get("llmChoice") ?? "").trim() !== "";
    try {
      const ops: SettingsOp[] = [...this.staged].map(([field, value]) => ({
        op: "set",
        path: [field],
        value,
      }));
      // The first save adopts this page as the authoritative config surface: until this marker is
      // set, the host projects NOTHING over the shared config file (see toRuntimeConfig). It rides
      // the same mutation the save already makes, so adoption cannot be lost to a failure the save
      // itself survives.
      if (ops.length && this.scope.getSnapshot().value?.adopted !== true) {
        ops.unshift({ op: "set", path: ["adopted"], value: true });
      }
      if (ops.length) {
        // No explicit revision: the scope fences with the latest it holds, and this page holds no
        // read it needs to defend — a conflict here is a lost race, not a stale editor.
        const landed = await this.scope.mutate(ops);
        if (!landed) {
          this.failed = true;
          return;
        }
        this.staged.clear();
      }
      await this.form.save();
      this.failed = this.form.shell().failed;
    } catch {
      this.failed = true;
    } finally {
      this.saving = false;
      if (modelPicked && !this.failed) {
        // After the save: the pick is in the document, so the run resolves it. Fire-and-forget for
        // the same reason the button is — this must not be able to fail the save it rides on.
        void this.runSetup();
      } else {
        this.publish();
      }
    }
  }

  private discard(): void {
    this.staged.clear();
    this.failed = false;
    this.form.actions().discard();
    this.publish();
  }

  /**
   * Read the secret presence markers out of the shared mirror, when the Host sends them.
   *
   * The literal never crosses the wire; the Host reports only whether each `role('secret')` path
   * currently holds a value. A Host that sends no markers at all leaves `secretKnown` false, and the
   * controls then avoid claiming "not configured" about a key that may well be stored.
   */
  private readSecretPresence(mirror: DescribeMirror): void {
    try {
      const row = mirror.getSnapshot().view?.namespaces?.find((candidate) => candidate?.ns === NAMESPACE);
      if (!row || !Array.isArray(row.secrets)) {
        this.secretKnown = false;
        return;
      }
      this.secretKnown = true;
      for (const field of [SECRET_FIELD]) {
        this.secretConfigured.set(
          field,
          row.secrets.some(
            (secret) =>
              Array.isArray(secret?.path) && secret.path.length === 1 && secret.path[0] === field && secret.set === true
          )
        );
      }
    } catch {
      this.secretKnown = false;
    }
  }

  private effective(field: string): unknown {
    if (this.staged.has(field)) return this.staged.get(field);
    const value = this.scope.getSnapshot().value?.[field];
    return value === undefined ? (DEFAULT_SETTINGS as unknown as Record<string, unknown>)[field] : value;
  }

  private publish(): void {
    this.store.set(this.projection());
  }

  private projection(): CardState {
    const shell = this.form.shell();
    const setup = parseSetupStatus(this.scope.getSnapshot().value?.setupStatus);
    // The host stamps its own clock, on this same machine: an answer newer than the request is an
    // answer, and anything older is the previous run still on screen.
    const answered = setup !== undefined && this.setupRequestedAt !== undefined && setup.at >= this.setupRequestedAt;
    const asking = this.setupRequestedAt !== undefined && !answered;
    // A host half that is not running writes nothing at all; after this long, saying "starting" is a
    // lie the user cannot act on, so the page stops claiming it.
    const stalled = asking && Date.now() - (this.setupRequestedAt ?? 0) > SETUP_ANSWER_TIMEOUT_MS;
    const boolean = (field: string): boolean => this.effective(field) === true;
    const stagedDirty = [...this.staged].some(
      ([field, value]) => value !== this.scope.getSnapshot().value?.[field]
    );
    return {
      available: shell.available,
      writable: shell.writable,
      invalid: shell.invalid,
      dirty: shell.dirty || stagedDirty,
      saving: this.saving,
      failed: this.failed || shell.failed,
      serverMode: String(this.effective("serverMode") ?? DEFAULT_SETTINGS.serverMode),
      autoInject: String(this.effective("autoInject") ?? DEFAULT_SETTINGS.autoInject),
      rehydrateMode: String(this.effective("rehydrateMode") ?? DEFAULT_SETTINGS.rehydrateMode),
      logLevel: String(this.effective("logLevel") ?? DEFAULT_SETTINGS.logLevel),
      enabled: boolean("enabled"),
      retainSessions: boolean("retainSessions"),
      compactionAware: boolean("compactionAware"),
      codeFactEnabled: boolean("codeFactEnabled"),
      autoSeed: boolean("autoSeed"),
      optInOnly: boolean("optInOnly"),
      apiUrl: this.form.field("apiUrl"),
      apiPort: this.form.field("apiPort"),
      uvDir: this.form.field("uvDir"),
      bankId: this.form.field("bankId"),
      bankIdTemplate: this.form.field("bankIdTemplate"),
      llmChoice: String(this.effective("llmChoice") ?? ""),
      llmChoices: parseModelChoices(this.scope.getSnapshot().value?.modelChoices),
      llmChoiceStale: (() => {
        const picked = parseLlmChoice(String(this.effective("llmChoice") ?? ""));
        const choices = parseModelChoices(this.scope.getSnapshot().value?.modelChoices);
        return picked !== undefined && choices.length > 0 && !choices.some((choice) => llmChoiceKey(choice) === llmChoiceKey({ route: picked.route, model: picked.model ?? "" }));
      })(),
      setup,
      setupPending: asking && !stalled,
      setupUnanswered: stalled,
      setupUnavailable: this.setupWriteFailed,
      setupStartedAt: this.setupRequestedAt,
      apiToken: this.form.field(SECRET_FIELD),
      apiTokenConfigured: this.secretConfigured.get(SECRET_FIELD) === true,
      apiTokenKnown: this.secretKnown,
      // A fresh object per projection, not the controller's own: a selector reading
      // `snapshot.libraries` has to see a new reference when the list changed, or React would keep
      // the previous render.
      libraries: { ...this.libraries },
    };
  }
}

/** Read the host half's published choice list; anything unparsable is "nothing offered". */
function parseModelChoices(raw: unknown): Array<{ route: string; model: string }> {
  try {
    const parsed = typeof raw === "string" && raw.trim() ? (JSON.parse(raw) as unknown) : undefined;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((entry) =>
        typeof entry === "object" && entry !== null && typeof (entry as { route?: unknown }).route === "string" && typeof (entry as { model?: unknown }).model === "string"
          ? { route: (entry as { route: string }).route, model: (entry as { model: string }).model }
          : undefined
      )
      .filter((entry): entry is { route: string; model: string } => entry !== undefined);
  } catch {
    return [];
  }
}

/** How long a setup request may go unanswered before the page stops claiming it is starting.
 *  Exported for the timer test that advances the clock past it. */
export const SETUP_ANSWER_TIMEOUT_MS = 20_000;

/** The form fields this page renders, exported so a test can assert the two halves agree. */
export const CONTROLLED_FIELDS = FORM_FIELDS;
