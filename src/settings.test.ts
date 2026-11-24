import { describe, expect, it } from "vitest";
import { Config, toRuntimeConfig } from "./settings";
import { DEFAULT_SETTINGS, NAMESPACE, SECRET_FIELD } from "./fields";

/** The schema's fields, as the settings service reads them. */
function schemaFields(): Array<{ name: string; volatile: boolean; role?: string; default?: unknown }> {
  const dict = (Config as unknown as { dict: Record<string, unknown> }).dict;
  return Object.entries(dict).map(([name, schema]) => {
    const typed = schema as { meta?: { volatile?: boolean; role?: string; default?: unknown } };
    return { name, volatile: typed.meta?.volatile === true, role: typed.meta?.role, default: typed.meta?.default };
  });
}

describe("Config schema", () => {
  it("exposes every field as volatile, which is what makes it writable from the page", () => {
    const fields = schemaFields();
    // The settings service serves a namespace only when at least one field is volatile, and it
    // refuses a write to any path outside a volatile node. A field without it would be invisible
    // to the page that exists to write it.
    expect(fields.length).toBeGreaterThan(8);
    expect(fields.filter((field) => !field.volatile).map((field) => field.name)).toEqual([]);
  });

  it("marks the token as a secret and default-protects it", () => {
    const token = schemaFields().find((field) => field.name === SECRET_FIELD);
    expect(token?.role).toBe("secret");
    // A secret's default is stripped before a value reaches a browser; a non-empty default would
    // only ever be a placeholder that looks like a credential.
    expect(token?.default).toBe("");
  });

  it("defaults to something that works without an account", () => {
    expect(DEFAULT_SETTINGS.serverMode).toBe("daemon");
    expect(DEFAULT_SETTINGS.enabled).toBe(true);
  });

  it("names the settings namespace after the Loader entry id", () => {
    // The page writes `ctx.configForms.get(NAMESPACE)`; the host serves forms under the entry id.
    expect(NAMESPACE).toBe("hindsight");
  });
});

describe("toRuntimeConfig", () => {
  it("projects nothing before the first save, so the file stays the single source of truth", () => {
    // A volatile field reads as its default until the user saves — indistinguishable from a
    // deliberate choice of that default. An unadopted page must therefore project NOTHING:
    // otherwise the defaults (serverMode: "daemon" first among them) override the shared
    // config file of a user who never opened this page.
    const unadopted = toRuntimeConfig({
      ...DEFAULT_SETTINGS,
      enabled: false,
      serverMode: "self-hosted",
      apiPort: 9999,
      autoInject: "pages",
    });
    expect(unadopted).toEqual({});
  });

  it("projects every switch and enum once adopted, so the page is authoritative for what it renders", () => {
    const raw = toRuntimeConfig({
      ...DEFAULT_SETTINGS,
      adopted: true,
      enabled: false,
      serverMode: "self-hosted",
      autoInject: "pages",
      retainSessions: false,
      compactionAware: false,
      rehydrateMode: "auto",
      codeFactEnabled: true,
      autoSeed: false,
      optInOnly: true,
      logLevel: "debug",
      apiPort: 9999,
    });
    expect(raw).toMatchObject({
      disabled: true,
      serverMode: "self-hosted",
      apiPort: 9999,
      autoInject: "pages",
      retainSessions: false,
      compactionAware: false,
      rehydrateMode: "auto",
      codeFactEnabled: true,
      autoSeed: false,
      optInOnly: true,
      logLevel: "debug",
    });
  });

  it("omits blank text fields instead of erasing the shared config file", () => {
    // `mergeRaw` overwrites with whatever the layer holds, an empty string included: sending ""
    // would wipe a URL, a token, or an explicit bank id the user set in their own config file.
    const raw = toRuntimeConfig({ ...DEFAULT_SETTINGS, adopted: true, apiUrl: "  ", apiToken: "", bankId: "" });
    expect("apiUrl" in raw).toBe(false);
    expect("apiToken" in raw).toBe(false);
    expect("bankId" in raw).toBe(false);
  });

  it("sends trimmed values when the page names them", () => {
    const raw = toRuntimeConfig({
      ...DEFAULT_SETTINGS,
      adopted: true,
      serverMode: "self-hosted",
      apiUrl: "  http://localhost:8888  ",
      apiToken: "  tok  ",
      bankId: " team  ",
    });
    expect(raw.apiUrl).toBe("http://localhost:8888");
    expect(raw.apiToken).toBe("tok");
    expect(raw.bankId).toBe("team");
  });

  it("projects nothing at all for a config the Loader has not filled in", () => {
    // Undefined settings mean the plugin never saw a config; the defaults do NOT flow into the
    // overrides layer — the file (and the runtime's own defaults below it) stay in force.
    expect(toRuntimeConfig(undefined)).toEqual({});
  });
});
