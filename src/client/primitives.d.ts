/**
 * Types for the dsh web client's UI primitive library.
 *
 * The shipped package is a prebuilt browser bundle with no `.d.ts` files, and it is NOT an npm
 * dependency we could install if it had them: it is part of the application, served to the browser
 * from the platform module table. So the subset this page uses is declared here, from the runtime's
 * own destructuring patterns — the member list is exact, and the type names are ours.
 *
 * `tsconfig.json` maps the module specifier onto this file, and the build script marks the
 * specifier external, so the bundle keeps `require("@deepseek-ai/dsh-client-ui-primitives")` and
 * the loader answers it at runtime.
 */
import type { ReactNode } from "react";

/** One scalar field's staged state, straight from `SettingsFormModel.field()`. */
export interface FieldState {
  text: string;
  overridden: boolean;
  invalid: boolean;
}

/** A field the form model stages as text and writes on save. */
export interface FieldSpec {
  field: string;
  format(value: unknown): string;
  parse(text: string): { kind: "clear" } | { kind: "set"; value: unknown } | undefined;
}

/** A field whose literal never rides a settings response, written through its own callback. */
export interface SecretSpec {
  field: string;
  write(text: string): boolean | Promise<boolean>;
}

/** What `SettingsForm` needs to decide whether Save is available and how to word the footer. */
export interface FormShell {
  available: boolean;
  writable: boolean;
  dirty: boolean;
  invalid: boolean;
  saving: boolean;
  failed: boolean;
}

/** The form's own editing verbs, bound as slot props. */
export interface FormActions {
  edit(field: string, text: string): void;
  resetField(field: string): void;
  save(): void;
  discard(): void;
}

/** One settings write, as `ctx.remote.settings.mutate` takes them. */
export interface SettingsOp {
  op: "set" | "unset";
  path: string[];
  value?: unknown;
}

/** A namespace-scoped view over the shared settings document. */
export interface SettingsScopeSnapshot {
  status: "loading" | "ready" | "unavailable";
  value?: Record<string, unknown>;
  base?: Record<string, unknown>;
  user?: Record<string, unknown>;
  revision?: number;
  writable: boolean;
  mode: "host" | "memory";
}

/** The scope `ctx.configForms.get(entryId)` returns. */
export interface SettingsScope {
  getSnapshot(): SettingsScopeSnapshot;
  subscribe(listener: () => void): () => void;
  set(field: string, value: unknown): Promise<boolean>;
  unset(field: string): Promise<boolean>;
  mutate(ops: SettingsOp[], expectedRevision?: number): Promise<boolean>;
}

/** A synchronous observable a slot component reads through its `use<Name>` prop. */
export interface SnapshotStore<S> {
  getSnapshot(): S;
  subscribe(listener: () => void): () => void;
  set(next: S): void;
}

/** The staged form behind a settings page. */
export class SettingsFormModel<S = unknown> {
  constructor(scope: SettingsScope, specs: FieldSpec[], secrets?: SecretSpec[]);
  bind<T>(project: () => T): SnapshotStore<T>;
  shell(): FormShell;
  field(name: string): FieldState;
  actions(): FormActions;
  save(): Promise<void>;
  dispose(): void;
}

export function settingsTextField(field: string): FieldSpec;
export function settingsNumberField(field: string): FieldSpec;

export function SettingsForm(props: {
  state: FormShell;
  labels: { unavailable: string; readOnly: string; saveFailed: string; save: string; saving: string };
  children?: ReactNode;
  onSave: () => void;
  onDiscard: () => void;
}): ReactNode;

export function SettingsValueField(props: {
  id: string;
  label: string;
  hint?: string;
  placeholder?: string;
  overridden: boolean;
  overriddenLabel: string;
  resetLabel: string;
  disabled?: boolean;
  onReset: () => void;
  invalid: boolean;
  invalidLabel?: string;
  numeric?: boolean;
  text: string;
  onEdit: (text: string) => void;
}): ReactNode;

export function SettingsSecretField(props: {
  id: string;
  label: string;
  hint?: string;
  disabled?: boolean;
  text: string;
  configured: boolean;
  stateLabel: string;
  onEdit: (text: string) => void;
}): ReactNode;

export function Switch(props: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  disabled?: boolean;
  title?: string;
  className?: string;
}): ReactNode;
