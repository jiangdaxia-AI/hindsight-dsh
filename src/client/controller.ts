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
import { parseSetupStatus, type SetupStatus } from "../setup-types";

/** One row of the shared settings-describe mirror, as the browser receives it. */
interface DescribeRow {
  ns?: string;
  /** Presence markers for `role('secret')` fields: the literal never crosses the wire. */
  secrets?: Array<{ path?: unknown; set?: unknown }>;
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
  /** Set when the host refused the request write itself: an older host half, before a restart. */
  private setupWriteFailed = false;
  /** field -> whether the Host reports a stored value at that secret path. */
  private readonly secretConfigured = new Map<string, boolean>();
  /** Whether the Host sent presence markers at all: absence is not "not configured". */
  private secretKnown = false;
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

  /** Release the form's subscription and this page's mirror subscription. */
  dispose(): void {
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
   */
  async runSetup(): Promise<void> {
    const nonce = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    this.setupRequestedAt = Date.now();
    this.setupWriteFailed = false;
    // The staged switches would win over the values written here, so drop the two this writes.
    this.staged.delete("enabled");
    this.staged.delete("serverMode");
    this.publish();
    try {
      const landed = await this.scope.mutate([
        { op: "set", path: ["enabled"], value: true },
        { op: "set", path: ["serverMode"], value: "daemon" },
        { op: "set", path: ["setupRequest"], value: nonce },
      ]);
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
    };
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

/** How long a setup request may go unanswered before the page stops claiming it is starting. */
const SETUP_ANSWER_TIMEOUT_MS = 20_000;

/** The form fields this page renders, exported so a test can assert the two halves agree. */
export const CONTROLLED_FIELDS = FORM_FIELDS;
