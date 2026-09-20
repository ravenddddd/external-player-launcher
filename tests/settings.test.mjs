/**
 * The settings' own rules, tested where they can be: without a browser.
 *
 * Run with `npm test` (Node's own test runner, so nothing has to be installed).
 * What is *not* here is everything else this plugin does — the buttons, the links,
 * the settings panel — which needs a browser and a Stash to be meaningful; see the
 * README.
 *
 * The source is TypeScript and Node runs it directly: type stripping has been on by
 * default since Node 23, and this file has no syntax that needs compiling away.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BUILT_IN_DEFAULTS,
  PLATFORM_KEYS,
  hasOverride,
  parseSettings,
  parseStored,
  platformKey,
  resolveSettings,
  withDefaultSettings,
  withPlatformSettings,
} from "../src/settings.ts";

const ua = {
  windows:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  // An Android browser says Linux, and a plain substring test answers wrongly.
  android:
    "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Mobile Safari/537.36",
  // An iPad says Macintosh, and modern iPads report a desktop user agent at all.
  ipad: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
  iphone:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  macos:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  linux:
    "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0",
  other: "Some Appliance/1.0",
};

describe("which platform a user agent is", () => {
  it("recognises each family", () => {
    assert.equal(platformKey(ua.windows), "windows");
    assert.equal(platformKey(ua.android), "android");
    assert.equal(platformKey(ua.iphone), "ios");
    assert.equal(platformKey(ua.macos), "macos");
    assert.equal(platformKey(ua.linux), "linux");
    assert.equal(platformKey(ua.other), "other");
  });

  it("answers with the platform that matters, not the one that appears first", () => {
    // An Android browser says Linux in its user agent, so a plain substring test
    // answers "linux" for it. The wrong answer means editing the wrong settings.
    assert.equal(platformKey(ua.android), "android");
  });

  it("tells an iPad from a Mac, which the user agent alone cannot", () => {
    // Since iPadOS 13 an iPad reports a desktop user agent: "Macintosh; Intel Mac
    // OS X", with no "iPad" in it. The touchscreen is the only thing that settles
    // it, and getting it wrong means an iPad edits the Mac's settings.
    assert.equal(platformKey(ua.ipad, 5), "ios");
    assert.equal(
      platformKey(ua.ipad),
      "macos",
      "and with no touchscreen reported, it is a Mac — the answer this has to fall " +
        "back on when the caller passes nothing"
    );
  });

  it("has an answer for nothing at all", () => {
    assert.equal(platformKey(""), "other");
    assert.equal(platformKey(undefined), "other");
  });
});

describe("what is in storage", () => {
  it("is nothing, for a browser that has never been configured", () => {
    assert.equal(parseStored(null), null);
    assert.equal(parseStored(""), null);
    assert.equal(parseStored("not json"), null);
    assert.equal(parseStored("[]"), null);
  });

  it("ignores a value written by another version, rather than guessing at it", () => {
    // The shape this plugin wrote before it had platforms: recognised by having no
    // version. There is no migration, so it reads as "never configured".
    assert.equal(
      parseStored(JSON.stringify({ excludedPlayerIds: [], singlePlayerMode: true })),
      null
    );
    assert.equal(parseStored(JSON.stringify({ version: 1, default: {} })), null);
  });

  it("keeps the fields it understands and drops the rest", () => {
    const stored = parseStored(
      JSON.stringify({
        version: 2,
        default: {
          singlePlayerMode: true,
          singlePlayerId: "potplayer",
          showSceneCardButtons: "yes",
          somethingElse: 4,
        },
        platforms: { android: { singlePlayerId: "mxplayer" } },
      })
    );

    assert.deepEqual(stored.default, {
      singlePlayerId: "potplayer",
      singlePlayerMode: true,
    });
    assert.deepEqual(stored.platforms.android, { singlePlayerId: "mxplayer" });
  });

  it("does not count an entry with nothing in it as an override", () => {
    // Otherwise a platform holding `{}` would shadow the default with nothing, and
    // the panel would say it had settings of its own when it has none.
    const stored = parseStored(
      JSON.stringify({ version: 2, default: {}, platforms: { android: {} } })
    );

    assert.deepEqual(stored.platforms, {});
    assert.equal(hasOverride(stored, "android"), false);
  });

  it("applies the same rule to an object, which is what Stash answers with", () => {
    // The server hands back an object and a cache holds text; one rule covers both,
    // so both are tested. An empty configuration is a value — not the same thing as
    // nothing at all, though they come to the same settings.
    assert.deepEqual(
      parseSettings({ version: 2, default: { singlePlayerId: "vlc" }, platforms: {} }),
      { version: 2, default: { singlePlayerId: "vlc" }, platforms: {} }
    );
    assert.deepEqual(parseSettings({ version: 2 }), {
      version: 2,
      default: {},
      platforms: {},
    });
    assert.equal(parseSettings(null), null);
    assert.equal(parseSettings("a string"), null);
    assert.equal(parseSettings([]), null);
  });
});

describe("what a platform ends up using", () => {
  const stored = parseStored(
    JSON.stringify({
      version: 2,
      default: { singlePlayerMode: true, singlePlayerId: "potplayer" },
      platforms: { android: { singlePlayerId: "mxplayer" } },
    })
  );

  it("inherits the default when it has no settings of its own", () => {
    const settings = resolveSettings(stored, "windows");

    assert.equal(settings.singlePlayerId, "potplayer");
    assert.equal(settings.singlePlayerMode, true);
    assert.equal(hasOverride(stored, "windows"), false);
  });

  it("takes the default field by field, not wholesale", () => {
    // The whole point of the merge: a platform that changed one field keeps the
    // default's answer for the others.
    const android = resolveSettings(stored, "android");

    assert.equal(android.singlePlayerId, "mxplayer", "the platform's own value");
    assert.equal(android.singlePlayerMode, true, "and the default's, untouched");
  });

  it("falls back to the built-in defaults, field by field, below both", () => {
    const settings = resolveSettings(stored, "linux");

    assert.equal(settings.showSceneCardButtons, BUILT_IN_DEFAULTS.showSceneCardButtons);
    assert.equal(settings.excludedPlayerIds, BUILT_IN_DEFAULTS.excludedPlayerIds);
  });

  it("answers for a browser that has never been configured", () => {
    assert.deepEqual(resolveSettings(null, "windows"), {
      ...BUILT_IN_DEFAULTS,
      excludedPlayerIds: [],
    });
  });
});

describe("changing what is stored", () => {
  const base = withDefaultSettings(null, {
    ...BUILT_IN_DEFAULTS,
    singlePlayerId: "vlc",
  });

  it("keeps the base settings without touching the platforms", () => {
    const withPlatform = withPlatformSettings(base, "android", {
      ...BUILT_IN_DEFAULTS,
      singlePlayerId: "mxplayer",
    });

    assert.equal(resolveSettings(withPlatform, "windows").singlePlayerId, "vlc");
    assert.equal(resolveSettings(withPlatform, "android").singlePlayerId, "mxplayer");
  });

  it("puts a platform back to inheriting when its settings are removed", () => {
    const withPlatform = withPlatformSettings(base, "android", {
      ...BUILT_IN_DEFAULTS,
      singlePlayerId: "mxplayer",
    });
    const removed = withPlatformSettings(withPlatform, "android", null);

    assert.equal(hasOverride(removed, "android"), false);
    assert.equal(resolveSettings(removed, "android").singlePlayerId, "vlc");
  });

  it("does not change what it was given", () => {
    const before = JSON.stringify(base);
    withPlatformSettings(base, "android", BUILT_IN_DEFAULTS);
    withDefaultSettings(base, { ...BUILT_IN_DEFAULTS, singlePlayerId: "mpv" });

    assert.equal(JSON.stringify(base), before);
  });

  it("knows every platform it can be asked about", () => {
    // A key the panel offers but this list does not is a setting that can be edited
    // and never stored.
    assert.deepEqual(PLATFORM_KEYS, [
      "windows",
      "macos",
      "ios",
      "android",
      "linux",
      "other",
    ]);
  });
});
