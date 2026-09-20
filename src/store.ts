/**
 * Where the settings live: Stash's own configuration, and one copy of it in memory.
 *
 * WHY NOT localStorage, WHICH IS WHAT THIS USED TO USE. It was per browser, and
 * the plugin said so on its own panel — "All settings only affect this browser."
 * That is the problem, not a footnote: a private-browsing window has no storage at
 * all, so nothing is remembered, and the same reader on a phone and a laptop
 * configures the same plugin twice. Stash's configuration is where plugin settings
 * belong, and it is one place for every browser and every device.
 *
 * WHY THERE IS STILL SOMETHING IN MEMORY. Parts of this plugin are not React — the
 * button lists on scene cards are built inside patch callbacks — and they read the
 * settings synchronously. An answer from the network cannot be awaited there, so
 * it is fetched once and kept: `read()` is a local answer after that. The cache is
 * not a second source of truth; it is the first one, held.
 *
 * WHAT HAPPENS WHEN STASH CANNOT ANSWER. Nothing is invented and nothing is
 * thrown away: the cache keeps whatever it last held, and a first load that fails
 * leaves the built-in defaults in place. Either way the plugin works, with the
 * settings it has.
 */
import {
  parseSettings,
  platformKey,
  resolveDefault,
  resolveSettings,
  withDefaultSettings,
  withPlatformSettings,
} from "./settings";
import type { PlatformKey, PlatformSettings, StoredSettings } from "./settings";

/** The key the settings live under in Stash's configuration */
export const PLUGIN_ID = "external-player-launcher";

/**
 * Both settings operations go through Stash's own plugin API.
 *
 * `input` is the *whole* of this plugin's configuration, because that is what
 * `configurePlugin` does — the schema says it "overwrites the entire plugin
 * configuration for the given plugin", so a partial object would delete the rest.
 * Nothing else writes under this ID: the plugin declares no `settings:` in its yml,
 * so Stash's own settings page has nothing to offer here and never touches it.
 */
const SETTINGS_QUERY = [
  "query ExternalPlayerSettings {",
  "  configuration {",
  "    plugins",
  "  }",
  "}",
].join("\n");

const SAVE_MUTATION = [
  "mutation ExternalPlayerSettingsSave($id: ID!, $input: Map!) {",
  "  configurePlugin(plugin_id: $id, input: $input)",
  "}",
].join("\n");

/** The slice of Apollo this file uses */
interface ApolloClient {
  query(options: {
    query: unknown;
    fetchPolicy?: string;
  }): Promise<{ data?: { configuration?: { plugins?: Record<string, unknown> } } }>;
  mutate(options: {
    mutation: unknown;
    variables: Record<string, unknown>;
  }): Promise<{ data?: { configurePlugin?: unknown } }>;
}

/**
 * Stash's plugin API, as far as this file is concerned.
 *
 * Cast rather than declared globally: Stash injects it on `window` before any
 * plugin script runs, and this plugin's build never type-checks the sources —
 * esbuild strips types without reading them — so what is written here is what is
 * actually used, and nothing more.
 */
interface StashApi {
  libraries?: { Apollo?: { gql?: (text: string) => unknown } };
  GQL?: { gql?: (text: string) => unknown };
  utils: { StashService: { getClient(): ApolloClient } };
}

function pluginApi(): StashApi {
  return (window as unknown as { PluginApi: StashApi }).PluginApi;
}

/** The settings as Stash last answered, or null before the first answer */
let cache: StoredSettings | null = null;

/** The load in flight, so that asking twice does not fetch twice */
let loading: Promise<void> | null = null;

const listeners = new Set<() => void>();

/** Documents are built once: `gql` is a tag that parses, not a lookup. */
const documents: { query?: unknown; mutation?: unknown } = {};

function buildDocument(text: string): unknown {
  const api = pluginApi();
  const gql = api.libraries?.Apollo?.gql || api.GQL?.gql;
  if (!gql) {
    console.error(
      "[external-player-launcher] gql is not available, so the settings cannot " +
        "be read from or written to Stash"
    );
    return null;
  }

  return gql(text);
}

function queryDocument(): unknown {
  if (!documents.query) documents.query = buildDocument(SETTINGS_QUERY);
  return documents.query;
}

function mutationDocument(): unknown {
  if (!documents.mutation) documents.mutation = buildDocument(SAVE_MUTATION);
  return documents.mutation;
}

/** Tells every subscriber that the settings they read have changed */
function notify(): void {
  for (const listener of listeners) listener();
}

/** Subscribes to changes, and returns the way to stop */
export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Which platform this browser is, worked out once.
 *
 * It cannot change while the page is open, and the answer is needed on every read.
 */
let platform: PlatformKey | null = null;

export function currentPlatform(): PlatformKey {
  if (platform === null) {
    platform = platformKey(navigator.userAgent, navigator.maxTouchPoints);
  }

  return platform;
}

/** The settings a platform is using — synchronously, from memory */
export function read(target: PlatformKey = currentPlatform()): PlatformSettings {
  return resolveSettings(cache, target);
}

/** The settings every platform inherits, unless it has its own */
export function readDefault(): PlatformSettings {
  return resolveDefault(cache);
}

/** What Stash was last seen to hold: which platforms have settings of their own */
export function stored(): StoredSettings | null {
  return cache;
}

/**
 * Asks Stash for the settings, once.
 *
 * Called at plugin start. A failure is reported and leaves the last answer
 * standing, which on a first load means the built-in defaults — the plugin keeps
 * working either way, and the next page load tries again.
 */
export function load(): Promise<void> {
  if (loading) return loading;

  const document = queryDocument();
  const client = document ? pluginApi().utils.StashService.getClient() : null;
  if (!document || !client) return Promise.resolve();

  loading = client
    // no-cache: this is a read of a small object, and letting it into Apollo's
    // store would write a second copy of Stash's own configuration into the cache
    // its settings page reads from.
    .query({ query: document, fetchPolicy: "no-cache" })
    .then((result) => {
      const plugins = result?.data?.configuration?.plugins;
      const next = parseSettings(plugins?.[PLUGIN_ID]);

      // "Stash has nothing stored" and "Stash could not be asked" are the same
      // answer here — the built-in defaults — so there is nothing to distinguish
      // and nothing to clear: an answer that parses to nothing is not an answer.
      if (next) cache = next;
      notify();
    })
    .catch((e) => {
      console.error(
        "[external-player-launcher] could not read the settings from Stash, so " +
          "this session is using the defaults:",
        e
      );
    })
    .then(() => {
      loading = null;
    });

  return loading;
}

/**
 * Writes settings for one platform, and keeps them only if Stash took them.
 *
 * The cache is updated *after* the write lands, not before. An optimistic update
 * would leave the panel showing a setting the server does not have, which is the
 * one thing a settings screen must never do; the cost is that a slow Stash means a
 * slow tick, which is honest.
 *
 * `null` for the settings means this platform goes back to using the default.
 */
export function save(
  settings: PlatformSettings | null,
  target: PlatformKey = currentPlatform()
): Promise<void> {
  return write((stored) => withPlatformSettings(stored, target, settings));
}

/** Writes the settings every platform inherits unless it has its own */
export function saveDefault(settings: PlatformSettings): Promise<void> {
  return write((stored) => withDefaultSettings(stored, settings));
}

function write(next: (stored: StoredSettings | null) => StoredSettings): Promise<void> {
  const document = mutationDocument();
  const client = document ? pluginApi().utils.StashService.getClient() : null;
  if (!document || !client) {
    return Promise.reject(new Error("the settings cannot be saved without gql"));
  }

  const settings = next(cache);

  return client
    .mutate({
      mutation: document,
      variables: { id: PLUGIN_ID, input: settings },
    })
    .then((result) => {
      // The mutation answers with what Stash now holds, so the cache takes the
      // server's word rather than ours. The two cannot disagree about the shape —
      // Stash stores the object it was given — but there is no reason to guess at
      // which one is right when the answer is in hand.
      cache = parseSettings(result?.data?.configurePlugin) ?? settings;
      notify();
    })
    .catch((e) => {
      console.error(
        "[external-player-launcher] Stash would not take the settings, so they " +
          "have not changed:",
        e
      );
      throw e;
    });
}
