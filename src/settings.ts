/**
 * Where the settings live, and what a given platform ends up using.
 *
 * Pure data plus pure functions: no React, no Stash API, no DOM. The plugin's own
 * build bundles this into main.js, and `npm test` exercises it directly — which is
 * the only part of this plugin that can be tested without a browser, and the part
 * where getting it wrong loses somebody's settings.
 *
 * WHY THERE IS A `default` AND NOT A COPY PER PLATFORM. A reader who never opens
 * the settings should get the same sensible thing everywhere, and a reader who
 * cares sets it once in `default` and is done. A platform only gets an entry of
 * its own when somebody asks for one — so `platforms` holds the exceptions, and a
 * platform missing from it is not "unconfigured", it is "the default".
 */

/** The settings themselves, as the panel edits them. */
export interface PlatformSettings {
  /** Player IDs the reader turned off; anything not listed is shown */
  excludedPlayerIds: string[];
  singlePlayerId: string;
  singlePlayerMode: boolean;
  /** Show external player buttons on scene cards */
  showSceneCardButtons: boolean;
  /** Show the Players tab on scene detail pages */
  showSceneDetailButtons: boolean;
  /** Show external player buttons on the scene detail toolbar */
  showSceneToolbarButtons: boolean;
}

/** What a browser that has never been configured gets, and what every platform inherits */
export const BUILT_IN_DEFAULTS: PlatformSettings = {
  excludedPlayerIds: [],
  // The first player in the plugin's own list. Anything else is corrected when the
  // settings are resolved against the list of buttons that still exist.
  singlePlayerId: "iina",
  singlePlayerMode: false,
  showSceneCardButtons: true,
  showSceneDetailButtons: true,
  showSceneToolbarButtons: true,
};

/**
 * The platforms a setting can be kept for.
 *
 * Deliberately coarse — a family, not a device. These are the same distinctions the
 * plugin already makes when it builds a player's link, so a setting that means
 * something on one is never silently applied on another.
 */
export type PlatformKey =
  | "windows"
  | "macos"
  | "ios"
  | "android"
  | "linux"
  | "other";

/** The order the panel lists them in */
export const PLATFORM_KEYS: PlatformKey[] = [
  "windows",
  "macos",
  "ios",
  "android",
  "linux",
  "other",
];

/**
 * Which platform a browser is.
 *
 * The user-agent tests are the ones the plugin already used to build its links, in
 * the order that matters: an Android browser says `Linux`, so a plain "does it
 * contain Linux" answers wrongly for it.
 *
 * `maxTouchPoints` is there for one case a user agent cannot settle. Since iPadOS
 * 13 an iPad reports **a desktop user agent** — `Macintosh; Intel Mac OS X`, with
 * no "iPad" anywhere in the string — so by user agent alone an iPad is a Mac, and
 * would end up editing the Mac's settings. A touchscreen is what tells them apart,
 * and a Mac has none.
 */
export function platformKey(
  userAgent: string,
  maxTouchPoints = 0
): PlatformKey {
  const ua = String(userAgent || "");

  if (/android/i.test(ua)) return "android";
  if (/iPad|iPhone|iPod/i.test(ua)) return "ios";
  if (/Macintosh|MacIntel/i.test(ua)) {
    return maxTouchPoints > 1 ? "ios" : "macos";
  }
  if (/Windows|compatible/i.test(ua)) return "windows";
  if (/Ubuntu|Linux/i.test(ua)) return "linux";

  return "other";
}

/** What is kept in storage: the base settings, and the platforms that differ */
export interface StoredSettings {
  version: 2;
  default: Partial<PlatformSettings>;
  platforms: Partial<Record<PlatformKey, Partial<PlatformSettings>>>;
}

const bool = (value: unknown): boolean | undefined =>
  typeof value === "boolean" ? value : undefined;

const text = (value: unknown): string | undefined =>
  typeof value === "string" && value ? value : undefined;

/** A settings object from arbitrary parsed JSON: known fields only, right types only */
function readSettingsValue(value: unknown): Partial<PlatformSettings> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};

  const raw = value as Record<string, unknown>;

  return {
    excludedPlayerIds: Array.isArray(raw.excludedPlayerIds)
      ? raw.excludedPlayerIds.filter((id): id is string => typeof id === "string")
      : undefined,
    singlePlayerId: text(raw.singlePlayerId),
    singlePlayerMode: bool(raw.singlePlayerMode),
    showSceneCardButtons: bool(raw.showSceneCardButtons),
    showSceneDetailButtons: bool(raw.showSceneDetailButtons),
    showSceneToolbarButtons: bool(raw.showSceneToolbarButtons),
  };
}

/**
 * Reads a stored value, or null when there is nothing usable in it.
 *
 * Null means "this browser has never been configured", which is a different thing
 * from a settings object that happens to be empty. Anything unrecognised — another
 * plugin's value under our key, half-written JSON, or the shape an older version of
 * this plugin wrote — is null: there is no migration, and a value that cannot be
 * read is ignored rather than guessed at.
 *
 * Takes the value rather than text, because the two places it comes from differ:
 * Stash's configuration hands back an object, and the cache in front of it holds
 * text. `parseStored` is the text one; this is the rule both obey.
 */
export function parseSettings(value: unknown): StoredSettings | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;

  const record = value as Record<string, unknown>;
  if (record.version !== 2) return null;


  const platforms: StoredSettings["platforms"] = {};
  const stored = record.platforms;
  if (stored && typeof stored === "object" && !Array.isArray(stored)) {
    for (const key of PLATFORM_KEYS) {
      const entry = (stored as Record<string, unknown>)[key];
      if (entry === undefined) continue;

      // Only the fields that were actually there: what comes back is shaped like
      // what went in, and an entry that held no known field comes back empty —
      // which is not an override, since it would shadow the default with nothing.
      const settings = dropUndefined(readSettingsValue(entry));
      if (Object.keys(settings).length > 0) platforms[key] = settings;
    }
  }

  return {
    version: 2,
    default: dropUndefined(readSettingsValue(record.default)),
    platforms,
  };
}

/** The same rule, for a value that arrived as text */
export function parseStored(
  raw: string | null | undefined
): StoredSettings | null {
  if (!raw) return null;

  try {
    return parseSettings(JSON.parse(raw));
  } catch {
    return null;
  }
}

/**
 * The settings every platform inherits, unless it has its own.
 *
 * Field by field, so a stored object missing one field takes that field from the
 * built-in defaults rather than losing it and everything beside it.
 */
export function resolveDefault(stored: StoredSettings | null): PlatformSettings {
  return { ...BUILT_IN_DEFAULTS, ...dropUndefined(stored?.default) };
}

/**
 * The settings a platform ends up using — the default's, with its own over the top.
 *
 * Field by field, so a platform that changed one setting keeps the default's
 * answer for the others rather than losing the lot.
 */
export function resolveSettings(
  stored: StoredSettings | null,
  platform: PlatformKey
): PlatformSettings {
  return {
    ...resolveDefault(stored),
    ...dropUndefined(stored?.platforms?.[platform]),
  };
}

/** Whether a platform has settings of its own, rather than inheriting the default */
export function hasOverride(
  stored: StoredSettings | null,
  platform: PlatformKey
): boolean {
  return stored?.platforms?.[platform] !== undefined;
}

/** The stored settings with the base settings replaced */
export function withDefaultSettings(
  stored: StoredSettings | null,
  settings: PlatformSettings
): StoredSettings {
  return { ...fromStored(stored), default: settings };
}

/**
 * The stored settings with a platform's own settings set, or removed.
 *
 * `null` removes them, which is how the panel's "use the default for this
 * platform" switch turns itself off: the platform goes back to inheriting, and
 * nothing is left behind to shadow the default later.
 */
export function withPlatformSettings(
  stored: StoredSettings | null,
  platform: PlatformKey,
  settings: PlatformSettings | null
): StoredSettings {
  const next = fromStored(stored);
  const platforms = { ...next.platforms };

  if (settings === null) delete platforms[platform];
  else platforms[platform] = settings;

  return { ...next, platforms };
}

function fromStored(stored: StoredSettings | null): StoredSettings {
  return stored
    ? { version: 2, default: { ...stored.default }, platforms: { ...stored.platforms } }
    : { version: 2, default: {}, platforms: {} };
}

/** A copy without the keys that are absent, so a spread cannot overwrite with undefined */
function dropUndefined(
  value: Partial<PlatformSettings> | undefined
): Partial<PlatformSettings> {
  if (!value) return {};

  const next: Partial<PlatformSettings> = {};
  for (const [key, field] of Object.entries(value)) {
    if (field !== undefined) (next as Record<string, unknown>)[key] = field;
  }

  return next;
}
