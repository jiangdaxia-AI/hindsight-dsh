/**
 * A test double for the application's UI primitive library.
 *
 * `SettingsFormModel` and the two field descriptors are transcribed from the shipped bundle
 * (`@deepseek-ai/dsh-client-ui-primitives` 0.2.0-rc.2, regions `lib/types/settings-form/*`), because
 * the library is an application module with no npm install a unit test could resolve. The
 * transcription keeps the semantics the controller depends on — what a plan contains, when a secret
 * is skipped, when `field()` reports an override — so a controller test fails when that contract
 * changes. It is a double, not a substitute: it is not what ships, and it does not test the library.
 */
import { createElement, Fragment, type ReactNode } from "react";
import type {
  FieldSpec,
  FieldState,
  FormActions,
  FormShell,
  SecretSpec,
  SettingsOp,
  SettingsScope,
  SnapshotStore,
} from "../primitives";

interface Staged {
  text: string;
  clear: boolean;
}

interface PlanItem {
  field: string;
  op?: SettingsOp;
  run?: () => Promise<boolean> | boolean;
}

/** Self-contained snapshot store, mirroring `@deepseek-ai/dsh-client-store`'s shape. */
function snapshotStore<S>(initial: S): SnapshotStore<S> {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    set(next) {
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}

export class SettingsFormModel {
  private readonly specs: Map<string, FieldSpec>;
  private readonly secretSpecs: Map<string, SecretSpec>;
  private readonly stagedMap = new Map<string, Staged>();
  private readonly listeners = new Set<() => void>();
  private baseline: ReturnType<SettingsScope["getSnapshot"]> | undefined;
  private saving = false;
  private failed = false;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly scope: SettingsScope,
    specs: FieldSpec[],
    secrets: SecretSpec[] = []
  ) {
    this.specs = new Map(specs.map((spec) => [spec.field, spec]));
    this.secretSpecs = new Map(secrets.map((spec) => [spec.field, spec]));
    this.unsubscribe = scope.subscribe(() => {
      this.publish();
    });
  }

  bind<T>(project: () => T): SnapshotStore<T> {
    const store = snapshotStore(project());
    this.listeners.add(() => {
      store.set(project());
    });
    return store;
  }

  shell(): FormShell {
    const snapshot = this.scope.getSnapshot();
    const plan = this.plan();
    return {
      available: snapshot.status === "ready",
      writable: snapshot.writable,
      dirty: plan.length > 0,
      invalid: plan.some((item) => item.run === undefined && item.op === undefined),
      saving: this.saving,
      failed: this.failed,
    };
  }

  field(field: string): FieldState {
    const staged = this.stagedMap.get(field);
    if (this.secretSpecs.has(field)) {
      return { text: staged?.text ?? "", overridden: false, invalid: false };
    }
    const spec = this.spec(field);
    if (staged === undefined) {
      return { text: spec.format(this.sectionValue(field)), overridden: this.stored(field), invalid: false };
    }
    const write = staged.clear ? ({ kind: "clear" } as const) : spec.parse(staged.text);
    return { text: staged.text, overridden: write?.kind === "set", invalid: write === undefined };
  }

  actions(): FormActions {
    return {
      edit: (field, text) => {
        this.stage(field, { text, clear: false });
      },
      resetField: (field) => {
        this.stage(field, { text: this.spec(field).format(this.baseValue(field)), clear: true });
      },
      save: () => {
        void this.save();
      },
      discard: () => {
        if (this.stagedMap.size === 0 && !this.failed) return;
        this.stagedMap.clear();
        this.baseline = undefined;
        this.failed = false;
        this.publish();
      },
    };
  }

  async save(): Promise<void> {
    const plan = this.plan();
    if (
      !plan.length ||
      this.saving ||
      !this.scope.getSnapshot().writable ||
      plan.some((item) => item.run === undefined && item.op === undefined)
    ) {
      return;
    }
    this.saving = true;
    this.failed = false;
    this.publish();
    try {
      const ops = plan.flatMap((item) => (item.op === undefined ? [] : [item.op]));
      let landed = !ops.length || (await this.scope.mutate(ops, this.baseline?.revision));
      if (!landed) {
        this.failed = true;
        return;
      }
      for (const item of plan) if (item.run) landed = (await item.run()) && landed;
      if (landed) {
        this.stagedMap.clear();
        this.baseline = undefined;
      }
      this.failed = !landed;
    } catch {
      this.failed = true;
    } finally {
      this.saving = false;
      this.publish();
    }
  }

  dispose(): void {
    this.unsubscribe();
    this.listeners.clear();
  }

  plan(): PlanItem[] {
    const plan: PlanItem[] = [];
    for (const [field, staged] of this.stagedMap) {
      const secret = this.secretSpecs.get(field);
      if (secret !== undefined) {
        const value = staged.text.trim();
        if (value !== "") plan.push({ field, run: () => secret.write(value) });
        continue;
      }
      const spec = this.spec(field);
      if (staged.clear) {
        if (this.stored(field)) plan.push({ field, op: { op: "unset", path: [field] } });
        continue;
      }
      if (staged.text === spec.format(this.sectionValue(field))) continue;
      const write = spec.parse(staged.text);
      if (write === undefined) plan.push({ field });
      else if (write.kind === "clear") plan.push({ field, op: { op: "unset", path: [field] } });
      else plan.push({ field, op: { op: "set", path: [field], value: write.value } });
    }
    return plan;
  }

  private stage(field: string, edit: Staged): void {
    this.baseline ??= this.scope.getSnapshot();
    this.stagedMap.set(field, edit);
    this.failed = false;
    this.publish();
  }

  private spec(field: string): FieldSpec {
    const spec = this.specs.get(field);
    if (!spec) throw new Error(`unknown field ${field}`);
    return spec;
  }

  private sectionValue(field: string): unknown {
    return this.scope.getSnapshot().value?.[field];
  }

  private baseValue(field: string): unknown {
    return this.scope.getSnapshot().base?.[field];
  }

  private stored(field: string): boolean {
    return Object.hasOwn(this.scope.getSnapshot().user ?? {}, field);
  }

  private publish(): void {
    for (const listener of [...this.listeners]) listener();
  }
}

export function settingsNumberField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === "number" ? String(value) : ""),
    parse: (text) => {
      const trimmed = text.trim();
      if (trimmed === "") return { kind: "clear" };
      const parsed = Number(trimmed);
      return Number.isFinite(parsed) ? { kind: "set", value: parsed } : undefined;
    },
  };
}

export function settingsTextField(field: string): FieldSpec {
  return {
    field,
    format: (value) => (typeof value === "string" ? value : ""),
    parse: (text) => {
      const trimmed = text.trim();
      return trimmed === "" ? { kind: "clear" } : { kind: "set", value: trimmed };
    },
  };
}

/**
 * Presentational components.
 *
 * These render REAL structure — the label, the children, the accessible name, the state a test wants
 * to read — because `section.test.ts` renders the settings page and asserts on what it built. They
 * are still doubles: geometry, CSS and interaction belong to the library, and a change there is not
 * something this file can notice.
 */
export const SettingsForm = (props: { children?: ReactNode }) => createElement(Fragment, null, props.children);

export const SettingsValueField = (props: { label: string; hint?: string }) =>
  createElement("div", { "data-field": props.label }, props.hint ?? null);

export const SettingsSecretField = (props: { label: string }) => createElement("div", { "data-field": props.label });

export const Switch = (props: { checked: boolean; label: string; disabled?: boolean }) =>
  createElement("button", { "data-switch": props.label, "aria-checked": props.checked, disabled: props.disabled });

export const Button = (props: {
  icon?: ReactNode;
  children?: ReactNode;
  disabled?: boolean;
  "aria-label"?: string;
  onClick?: () => void;
}) =>
  createElement(
    "button",
    { "aria-label": props["aria-label"], disabled: props.disabled, onClick: props.onClick },
    props.icon ?? null,
    props.children ?? null,
  );

export const Tag = (props: { tone?: string; children?: ReactNode }) =>
  createElement("span", { "data-tag": props.tone ?? "outline" }, props.children ?? null);

export const StateDot = (props: { state: string }) => createElement("span", { "data-state": props.state });

/** Attaches nothing: the real Tooltip clones its child, which a test has no reason to reproduce. */
export const Tooltip = (props: { label: string; children?: ReactNode }) =>
  createElement("span", { "data-tooltip": props.label }, props.children ?? null);

/**
 * The destructive-action dialog.
 *
 * Rendered as one element carrying every prop it was handed, because what a test must be able to
 * read is what the page ASKED for — the warning text, the acknowledgement copy, whether it is open.
 * The real dialog's focus trap, Escape handling and checkbox belong to the library.
 */
export const RiskConfirmation = (props: { open: boolean } & Record<string, unknown>) =>
  createElement("div", { ...props, "data-confirmation": String(props.open) });

/** Icons are vector artwork; a test only needs to see that the right one was placed. */
export const IconRefreshOutlineRegular = () => createElement("span", { "data-icon": "refresh" });
export const IconTrashOutlineRegular = () => createElement("span", { "data-icon": "trash" });
