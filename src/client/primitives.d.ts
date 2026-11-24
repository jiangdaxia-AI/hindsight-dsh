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
import type { ReactElement, ReactNode } from "react";

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

/**
 * A vector icon from the library's own set.
 *
 * Every icon is a 16pt-viewBox SVG that inherits `currentColor` and already carries
 * `aria-hidden="true"`, which is why an icon beside a label needs no further accessibility work and
 * an icon-only control carries its name on the button instead. The member list this page uses is
 * declared below; the library ships roughly two hundred of them.
 */
export interface IconProps {
  size?: number;
  className?: string;
}

/**
 * The host's button.
 *
 * `variant` and `size` are the library's own scales: a `md` control is 36px tall and the `sm` one
 * 28px, `outline` is the neutral stroke the settings pages use for a secondary action, and
 * `primary` is the filled one. Copying these numbers by hand is how a page drifts from the host's
 * own controls, so the page uses the component.
 */
export function Button(props: {
  variant?: "primary" | "ghost" | "outline" | "toolbar";
  size?: "md" | "sm";
  icon?: ReactNode;
  className?: string;
  type?: "button" | "submit" | "reset";
  disabled?: boolean;
  title?: string;
  "aria-label"?: string;
  onClick?: (event: unknown) => void;
  children?: ReactNode;
}): ReactNode;

/** A fixed-geometry capsule label; `tone` is its only palette knob. */
export function Tag(props: {
  tone?: "outline" | "solid" | "neutral" | "quiet" | "success" | "info" | "warning" | "danger";
  className?: string;
  children?: ReactNode;
}): ReactNode;

/**
 * The host's status dot, whose colour comes from the theme's state steps rather than from a prop.
 *
 * `ongoing` is the one non-dot state: a spinner with the same footprint.
 */
export function StateDot(props: {
  state: "done" | "warning" | "error" | "idle" | "ongoing";
  size?: number;
  appearance?: "dot" | "step";
  className?: string;
}): ReactNode;

/**
 * A hover/focus label anchored to its single child, which it clones to attach its listeners — so
 * the child must accept a ref, as the library's own `Button` does.
 *
 * `side` and `align` decide the placement; the library flips the bubble to keep it inside the
 * viewport, so a row near an edge needs no handling here.
 */
export function Tooltip(props: {
  label: ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  gap?: number;
  disabled?: boolean;
  children: ReactElement;
}): ReactNode;

/**
 * The host's dialog: a portal over a blurred mask, with focus trapped inside and Escape wired to
 * `onClose`. `headless` drops the header/body and hands the whole surface to the caller.
 */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  closeLabel?: string;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  className?: string;
  contentClassName?: string;
  headless?: boolean;
  onKeyDownCapture?: (event: unknown) => void;
}): ReactNode;

/**
 * The host's destructive-action dialog: the warning, the acknowledgement checkbox the user must
 * tick, and the cancel/confirm pair. A confirm is impossible until `acknowledged` is true, which is
 * what makes it a two-step confirmation rather than a styled OK button.
 */
export function RiskConfirmation(props: {
  open: boolean;
  title: ReactNode;
  description: ReactNode;
  acknowledgeLabel: ReactNode;
  cancelLabel: string;
  closeLabel: string;
  confirmLabel: string;
  acknowledged: boolean;
  disabled?: boolean;
  onAcknowledgedChange: (next: boolean) => void;
  onCancel: () => void;
  onConfirm: () => void;
}): ReactNode;

export function IconRefreshOutlineRegular(props: IconProps): ReactNode;
export function IconTrashOutlineRegular(props: IconProps): ReactNode;
export function IconDatabaseOutlineRegular(props: IconProps): ReactNode;
export function IconWarningOutlineRegular(props: IconProps): ReactNode;
export function IconChevronDownOutlineRegular(props: IconProps): ReactNode;
