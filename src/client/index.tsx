/**
 * The browser half of this plugin.
 *
 * The host half owns the config schema; this half is the page that edits it. It registers into the
 * settings panel's `settings.section` slot — the same seat the built-in General/Models/Plugins pages
 * take — and only while the Host actually serves this plugin's settings namespace, so a deployment
 * that never loaded the host half shows no trace of the page.
 *
 * It requires NOTHING from the application at build time beyond React and the UI primitive library,
 * both of which the browser kernel already serves: the bundle keeps those as `require` calls and the
 * module loader answers them.
 */
import type { SettingsScope } from "@deepseek-ai/dsh-client-ui-primitives";
import { NAMESPACE } from "../fields";
import { HindsightCardController, type CardContext } from "./controller";
import { HindsightSection } from "./HindsightSection";
import { DICTIONARIES, NS } from "./locales";

/** Services this plugin needs. `slots` renders it, `locale` gives it `t`, `configForms` its writes. */
export const inject = ["slots", "locale", "configForms"];

/** The slice of the browser Cordis context this plugin uses. */
interface ClientContext {
  locale: {
    bind(namespace: string): (key: string) => string;
    register(namespace: string, dictionaries: Record<string, unknown>): () => void;
  };
  slots: {
    inject(name: string, register: () => unknown): () => void;
    register(definition: Record<string, unknown>, component: unknown): () => void;
  };
  configForms: CardContext["configForms"] & {
    get(namespace: string): SettingsScope;
    whileServed(namespaces: string[], register: (served: Set<string>) => (() => void) | void): () => void;
  };
  effect(callback: () => (() => void) | void, label?: string): unknown;
}

/**
 * Bind the settings page to the lifetime of `ctx`.
 *
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  const t = ctx.locale.bind(NS);
  ctx.effect(() => ctx.locale.register(NS, DICTIONARIES as unknown as Record<string, unknown>), "hindsight: dictionaries");
  // `get` is created once and reused: the scope is shared by every editor of this namespace, and
  // reading it before the Host serves it is a supported "unavailable" state, not an error.
  const card = new HindsightCardController(ctx.configForms.get(NAMESPACE), ctx as never);
  ctx.effect(() => () => card.dispose(), "hindsight: form subscription");
  ctx.effect(
    () =>
      ctx.configForms.whileServed([NAMESPACE], () =>
        ctx.slots.inject("settings.section", () =>
          ctx.slots.register(
            {
              name: "settings.section",
              id: "hindsight",
              // After General (0) and Models (10), beside Plugins (15) and Agent presets (20).
              order: 25,
              label: () => t("title"),
              locale: NS,
              inject: () => card.inject(),
            },
            HindsightSection
          )
        )
      ),
    "hindsight: settings page"
  );
}
