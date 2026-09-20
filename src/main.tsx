import { PLATFORM_CHOICES, hasOverride } from "./settings";
import type { PlatformKey } from "./settings";
import {
  PLUGIN_ID,
  currentPlatform,
  load as loadSettings,
  read as readStoredSettings,
  readDefault as readStoredDefaults,
  save as saveStoredSettings,
  saveDefault as saveStoredDefaults,
  stored as storedSettings,
  subscribe,
} from "./store";

declare const __PLUGIN_VERSION__: string;

(function () {
  const { PluginApi } = window;
  const { React, ReactDOM } = PluginApi;
  const { Bootstrap, FontAwesomeSolid, FontAwesomeBrands, Intl, ReactSelect } =
    PluginApi.libraries;
  const { Nav, Tab, Button, ButtonGroup, Dropdown, Modal,
    Form, OverlayTrigger, Tooltip
  } = Bootstrap;
  const { Icon, } = PluginApi.components;
  const { faGear } = FontAwesomeSolid;
  const { useConfiguration } = PluginApi.utils.StashService;
  const { IntlProvider, FormattedMessage } = Intl;

  // Stash's own dropdown, the one its own selectors are made of. The tag is a
  // module, so the component is whichever name it exports as its default.
  const Select = ReactSelect.default || ReactSelect.Select;

  // Plugin version, injected at build time
  const PLUGIN_VERSION = __PLUGIN_VERSION__;

  // The ID comes from store.ts, which needs it as the key the settings live under
  // in Stash's configuration: one spelling, in one place.
  const pluginID = PLUGIN_ID;
  const iconsPath = "./plugin/external-player-launcher/assets/icons";
  const localesBase = `./plugin/external-player-launcher/assets/locales`;

  // Asked for once, as early as the plugin can ask. Everything that draws a button
  // reads the settings, and until Stash answers they are the built-in defaults —
  // they are kept in Stash rather than in this browser, for the reasons store.ts
  // gives.
  void loadSettings();

  const playerButtons = [
    { id: "iina", name: "IINA", onClick: openIINA },
    { id: "infuse", name: "Infuse", onClick: openInfuse },
    { id: "mpchc", name: "MPC-HC", onClick: openMPCHC },
    { id: "mpv", name: "MPV", onClick: openMPV },
    { id: "mxplayer", name: "MX Player", onClick: openMXPlayer },
    { id: "mxplayerpro", name: "MX Player Pro", onClick: openMXPlayerPro },
    { id: "nplayer", name: "nPlayer", onClick: openNPlayer },
    { id: "potplayer", name: "PotPlayer", onClick: openPotplayer },
    { id: "vlc", name: "VLC", onClick: openVlc },
  ];

  type PlayerButton = typeof playerButtons[number];

  const messagesCache: Record<string, Promise<Record<string, string>> | undefined> = {};
  const defaultLocale = 'en-US';

  /**
   * Load localized messages for the given locale.
   * Reuses the cached Promise when the locale has already been requested,
   * and falls back to the default locale when the language file is unavailable.
   */
  function loadMessages(locale: string): Promise<Record<string, string>> {
    if (messagesCache[locale]) return messagesCache[locale];

    const promise = (async () => {
      const tryLoad = async (l: string): Promise<Record<string, string>> => {
        const res = await fetch(`${localesBase}/${l}.json?v=${PLUGIN_VERSION}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return (await res.json()) as Record<string, string>;
      };

      try {
        return await tryLoad(locale);
      } catch {
        // Fall back to the default locale
        if (locale !== defaultLocale) return loadMessages(defaultLocale);
        return {};
      }
    })();

    messagesCache[locale] = promise;
    return promise;
  }

  function PluginIntlProvider({ children }: { children: React.ReactNode }) {
    const config = useConfiguration();
    const language: string | undefined =
      config.data?.configuration?.interface?.language;
    const locale = language || defaultLocale;

    const [messages, setMessages] = React.useState<Record<string, string>>({});

    React.useEffect(() => {
      let cancelled = false;
      loadMessages(locale).then(msgs => {
        if (!cancelled) setMessages(msgs);
      });
      return () => { cancelled = true; };
    }, [locale]);

    return React.createElement(
      IntlProvider,
      { locale, messages, defaultLocale: defaultLocale },
      children
    );
  }

  interface SettingsState {
    /** List of excluded (deselected) player IDs; players not in this list are checked by default */
    excludedPlayerIds: string[];
    singlePlayerId: string;
    singlePlayerMode: boolean;
    /** Show external player buttons on scene cards */
    showSceneCardButtons: boolean;
    /** Show external player buttons on scene detail page (tabs) */
    showSceneDetailButtons: boolean;
    /** Show external player buttons on scene detail page toolbar */
    showSceneToolbarButtons: boolean;
  }

  /**
   * What the Reset button goes back to.
   *
   * Built from the players this version of the plugin has, rather than taken from
   * the store's built-in defaults, so resetting always lands on a settings object
   * that names a player that exists.
   */
  const defaultSettings: SettingsState = {
    excludedPlayerIds: [],
    singlePlayerId: playerButtons[0].id,
    singlePlayerMode: false,
    showSceneCardButtons: true,
    showSceneDetailButtons: true,
    showSceneToolbarButtons: true,
  };

  function cloneSettings(settings: SettingsState): SettingsState {
    return { ...settings };
  }

  /**
   * The settings for one of the panel's entries, answered from memory.
   *
   * Corrected against the players this version of the plugin has on the way out: a
   * stored object can name one that has since been removed, or exclude all of them,
   * and neither is a state the button lists can draw.
   */
  function readSettingsFor(target: PlatformKey | "default"): SettingsState {
    const stored =
      target === "default" ? readStoredDefaults() : readStoredSettings(target);
    const validIds = playerButtons.map((button) => button.id);
    const settings: SettingsState = { ...stored };

    if (!validIds.includes(settings.singlePlayerId)) {
      settings.singlePlayerId = defaultSettings.singlePlayerId;
    }

    settings.excludedPlayerIds = settings.excludedPlayerIds.filter((id) =>
      validIds.includes(id)
    );
    if (settings.excludedPlayerIds.length >= validIds.length) {
      settings.excludedPlayerIds = [];
    }

    return settings;
  }

  /**
   * The settings this browser should use.
   *
   * Named and shaped as it always was, because the parts of this plugin that are
   * not React — the patch callbacks that put the tab and the toolbar buttons on a
   * scene page — read it that way and have no way to wait for an answer.
   */
  function readSettings(): SettingsState {
    return readSettingsFor(currentPlatform());
  }

  /**
   * The settings, and a re-render whenever they change.
   *
   * Subscribed rather than read once: a save has to reach what is on screen, and
   * with the settings in Stash rather than in this browser there is no `storage`
   * event to lean on for it.
   */
  function useSettingsState() {
    const [settings, setSettings] = React.useState<SettingsState>(() => readSettings());

    React.useEffect(() => subscribe(() => setSettings(readSettings())), []);

    return { settings };
  }

  function filterPlayerButtons(settings: SettingsState): PlayerButton[] {
    if (settings.singlePlayerMode) {
      const player = playerButtons.find((button) => button.id === settings.singlePlayerId);
      return player ? [player] : [];
    }

    // excludedPlayerIds stores excluded player IDs; players not in the list are visible
    return playerButtons.filter((button) => !settings.excludedPlayerIds.includes(button.id));
  }

  function getSinglePlayerButton(settings: SettingsState): PlayerButton {
    return filterPlayerButtons(settings)[0] || playerButtons[0];
  }

  const OS = {
    isAndroid: (): boolean => /android/i.test(navigator.userAgent),
    isIOS: (): boolean => /iPad|iPhone|iPod/i.test(navigator.userAgent),
    isMacOS: (): boolean => /Macintosh|MacIntel/i.test(navigator.userAgent),
    isApple: (): boolean => OS.isMacOS() || OS.isIOS(),
    isWindows: (): boolean => /compatible|Windows/i.test(navigator.userAgent),
    isMobile: (): boolean => OS.isAndroid() || OS.isIOS(),
    isUbuntu: (): boolean => /Ubuntu/i.test(navigator.userAgent),
    isLinux: (): boolean => /Linux/i.test(navigator.userAgent),
    isOthers: (): boolean => Object.entries(OS).filter(([key, val]) => key !== 'isOthers').every(([key, val]) => !val()),
  };

  async function writeClipboard(text: string): Promise<boolean> {
    let flag = false;
    if (navigator.clipboard) {
      // Firefox needs https
      try {
        await navigator.clipboard.writeText(text);
        flag = true;
        console.log("Successfully used navigator.clipboard modern clipboard implementation");
      } catch (error) {
        console.error('Error occurred when copying to clipboard using navigator.clipboard:', error);
      }
    } else {
      flag = writeClipboardLegacy(text);
      console.log("navigator.clipboard modern clipboard implementation not available, using legacy implementation");
    }
    return flag;
  }

  function writeClipboardLegacy(text: string): boolean {
    let textarea = document.createElement('textarea');
    document.body.appendChild(textarea);
    textarea.style.position = 'absolute';
    textarea.style.clip = 'rect(0 0 0 0)';
    textarea.value = text;
    textarea.select();
    if (document.execCommand('copy', true)) {
      return true;
    }
    return false;
  }

  interface SceneInfo {
    title: string;
    streamUrl: string;
    captionUrl: string;
    position: number;
    props: any;
  }

  function getSceneInfo(props: any): SceneInfo {
    let title = props.scene.title;
    const streamUrl = props.scene.paths.stream;
    const captionUrl = props.scene.paths.caption;
    const position = parseInt(props.scene.resume_time) || 0;

    if (!title) {
      const path = props.scene.files?.[0]?.path;
      if (path) {
        title = path.split(/[\\/]/).pop();
      }
    }

    return { title, streamUrl, captionUrl, position, props };
  }

  function getSeek(seconds: number): string {
    const totalMs = Math.round(seconds * 1000);

    const hours = Math.floor(totalMs / 3600000);
    const minutes = Math.floor((totalMs % 3600000) / 60000);
    const secs = Math.floor((totalMs % 60000) / 1000);
    const ms = totalMs % 1000;

    return `${String(hours).padStart(2, '0')}:` +
      `${String(minutes).padStart(2, '0')}:` +
      `${String(secs).padStart(2, '0')}.` +
      `${String(ms).padStart(3, '0')}`;
  }

  function urlSafeBase64Encode(input: string): string {
    return btoa(String.fromCharCode.apply(null, [...new Uint8Array(new TextEncoder().encode(input))]))
      .replace(/\//g, "_").replace(/\+/g, "-").replace(/\=/g, "");
  }

  // https://github.com/iina/iina/issues/1991
  function openIINA(info: SceneInfo) {
    let iinaUrl = `iina://weblink?url=${encodeURIComponent(info.streamUrl)}&new_window=1`;
    console.log(`iinaUrl= ${iinaUrl}`);
    window.open(iinaUrl, "_self");
  }

  function openInfuse(info: SceneInfo) {
    // sub parameter limitation: Play single video file with external subtitles (Infuse 7.6.2 and above)
    // see: https://support.firecore.com/hc/zh-cn/articles/215090997
    let infuseUrl = `infuse://x-callback-url/play?url=${encodeURIComponent(info.streamUrl)}&sub=${encodeURIComponent(info.captionUrl)}`;
    console.log(`infuseUrl= ${infuseUrl}`);
    window.open(infuseUrl, "_self");
  }

  function openMPCHC(info: SceneInfo) {
    let mpchcUrl = `mpc-hc://${info.streamUrl}`;
    console.log(`mpchcUrl= ${mpchcUrl}`);
    window.open(mpchcUrl, "_self");
  }

  function openMPV(info: SceneInfo) {
    // Desktop requires additional setup, refer to this project: https://github.com/akiirui/mpv-handler
    const streamUrl64 = urlSafeBase64Encode(info.streamUrl);
    const subUrl64 = urlSafeBase64Encode(info.captionUrl);
    const title64 = urlSafeBase64Encode(info.title);
    let MPVUrl = `mpv-handler://play/${streamUrl64}/?subfile=${subUrl64}&v_title=${title64}&startat=${info.position}`;

    if (OS.isIOS()) {
      MPVUrl = `mpv://${encodeURI(info.streamUrl)}`;
    }
    if (OS.isMacOS()) {
      MPVUrl = `mpvplay://${encodeURI(info.streamUrl)}`;
    }
    if (OS.isAndroid()) {
      // https://mpv-android.github.io/mpv-android/intent.html
      const [scheme, streamBody] = info.streamUrl.split(/:\/\//, 2);
      const positionMs = info.position * 1000;
      MPVUrl = `intent://${encodeURI(streamBody)}#Intent;` +
        `scheme=${scheme};` +
        `package=is.xyz.mpv;` +
        `action=android.intent.action.VIEW;` +
        `type=video/any;` +
        `S.title=${encodeURI(info.title)};` +
        `S.subs=${encodeURI(info.captionUrl)};` +
        `i.position=${positionMs};` +
        `end`;
    }
    
    console.log('MPVUrl=', MPVUrl);
    window.open(MPVUrl, "_self");
  }

  function openMXPlayer(info: SceneInfo) {
    handleMXPlayer(info, false);
  }

  function openMXPlayerPro(info: SceneInfo) {
    handleMXPlayer(info, true);
  }

  // https://sites.google.com/site/mxvpen/api
  // https://mx.j2inter.com/api
  // https://support.mxplayer.in/support/solutions/folders/43000574903
  function handleMXPlayer(info: SceneInfo, isPro: boolean) {
    const packageName = isPro? "com.mxtech.videoplayer.pro": "com.mxtech.videoplayer.ad";
    const [scheme, streamBody] = info.streamUrl.split(/:\/\//, 2);
    const positionMs = info.position * 1000;
    const url = `intent://${encodeURI(streamBody)}#Intent;` +
      `scheme=${scheme};` +
      `package=${packageName};` +
      `action=android.intent.action.VIEW;` +
      `type=video/*;` +
      `S.title=${encodeURI(info.title)};` +
      `i.position=${positionMs};` +
      `end`;
    console.log(`mxPlayer url= ${url}`);
    window.open(url, "_self");
  }

  function openNPlayer(info: SceneInfo) {
    let nUrl = OS.isMacOS()
      ? `nplayer-mac://weblink?url=${encodeURIComponent(info.streamUrl)}&new_window=1`
      : `nplayer-${encodeURI(info.streamUrl)}`;
    console.log(`nPlayer url= ${nUrl}`);
    window.open(nUrl, "_self");
  }

  async function openPotplayer(info: SceneInfo) {
    if (!OS.isWindows()) return;
    let potUrl = `potplayer://${encodeURI(info.streamUrl)} /sub=${encodeURI(info.captionUrl)} /seek=${getSeek(info.position)} /title="${info.title}"`;
    await writeClipboard(potUrl);
    console.log("Successfully wrote real deep link to clipboard: ", potUrl);
    // Test shows no spaces also work, potplayer will automatically convert DeepLink to command line arguments, full parameters: PotPlayer About => Command Line Options
    potUrl = `potplayer:///current/clipboard`;
    window.open(potUrl, "_self");
  }

  async function openVlc(info: SceneInfo) {
    // Desktop requires additional setup, refer to this project:
    // new: https://github.com/northsea4/vlc-protocol
    // old: https://github.com/stefansundin/vlc-protocol
    let vlcUrl = `vlc://${info.streamUrl}`;

    if (OS.isAndroid()) {
      // android subtitles:  https://code.videolan.org/videolan/vlc-android/-/issues/1903
      const [scheme, streamBody] = info.streamUrl.split(/:\/\//, 2);
      const positionMs = info.position * 1000;
      vlcUrl = `intent://${encodeURI(streamBody)}#Intent;` +
        `scheme=${scheme};` +
        `package=org.videolan.vlc;` +
        `action=android.intent.action.VIEW;` +
        `type=video/*;` +
        `S.subtitles_location=${encodeURI(info.captionUrl)};` +
        `S.title=${encodeURI(info.title)};` +
        `i.position=${positionMs};` +
        `end`;
    }
    if (OS.isIOS()) {
      // https://wiki.videolan.org/Documentation:IOS/#x-callback-url
      // https://code.videolan.org/videolan/vlc-ios/-/commit/55e27ed69e2fce7d87c47c9342f8889fda356aa9
      vlcUrl = `vlc-x-callback://x-callback-url/stream?url=${encodeURIComponent(info.streamUrl)}&sub=${encodeURIComponent(info.captionUrl)}`;
    }
    console.log(`vlcUrl= ${vlcUrl}`);
    window.open(vlcUrl, "_self");
  }

  type InjectPosition = 'before' | 'after' | 'appendChild' | 'prependChild';
  type ReactNodePredicate = (node: any) => boolean;

  /**
   * Inject a new element into the React virtual DOM tree
   * @param node - Current recursive React node (initially the result)
   * @param predicate - Condition matching function
   * @param position - Insertion position
   * @param newElement - New React element to inject
   */
  function injectIntoReactTree(
    node: any,
    predicate: ReactNodePredicate,
    position: InjectPosition,
    newElement: React.ReactElement
  ): boolean {
    if (!node || !node.props) return false;

    // If the current node is the target and we are inserting a child element
    if (predicate(node) && (position === 'appendChild' || position === 'prependChild')) {
      const c = node.props.children;
      const arr: any[] = !c ? [] : Array.isArray(c) ? c : [c]; // Normalize to array
      position === 'appendChild' ? arr.push(newElement) : arr.unshift(newElement);
      node.props.children = arr;
      return true;
    }

    let children = node.props.children;
    if (!children) return false;

    // If a single child node matches the target, coerce it to an array for uniform processing
    if (!Array.isArray(children) && predicate(children)) {
      children = node.props.children = [children];
    }

    // Traverse and recurse
    if (Array.isArray(children)) {
      for (let i = 0; i < children.length; i++) {
        if (!children[i]) continue;

        if (predicate(children[i])) {
          if (position === 'before') {
            children.splice(i, 0, newElement);
            return true;
          }
          if (position === 'after') {
            children.splice(i + 1, 0, newElement);
            return true;
          }
          // If inserting a child element, force inject into the target node
          return injectIntoReactTree(children[i], () => true, position, newElement);
        }

        // Continue deeper recursion
        if (injectIntoReactTree(children[i], predicate, position, newElement)) return true;
      }
    } else {
      // Single node didn't match, continue recursing down
      return injectIntoReactTree(children, predicate, position, newElement);
    }

    return false;
  }

  const PortalMenu = React.forwardRef<HTMLDivElement, any>(function PortalMenu(props, ref) {
    return ReactDOM.createPortal(
      <div ref={ref} {...props} />,
      document.body
    );
  });

  function createButtonGroup() {
    return (
      <>
        <hr />
        <ButtonGroup className="card-popovers" />
      </>
    );
  }

  function createPlayIcon(props: React.SVGProps<SVGSVGElement> = {}) {
    return (
      <svg
        fill="currentColor"
        className="bi bi-play-btn-fill"
        viewBox="0 0 16 16"
        {...props}
      >
        <path d="M0 12V4a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H2a2 2 0 0 1-2-2zm6.79-6.907A.5.5 0 0 0 6 5.5v5a.5.5 0 0 0 .79.407l3.5-2.5a.5.5 0 0 0 0-.814l-3.5-2.5z" />
      </svg>
    );
  }

  /** Thin wrapper: provides IntlProvider context for SettingsModalInner */
  /**
   * A platform's name as the panel lists it.
   *
   * Written as its maker writes it, so it is not translated — "Windows" is
   * Windows in every language this plugin ships.
   */
  function platformName(key: PlatformKey): string {
    return {
      windows: "Windows",
      macos: "macOS",
      ios: "iOS",
      android: "Android",
      linux: "Linux",
      other: "Other",
    }[key];
  }

  /**
   * A platform's icon, or undefined for one this Stash has no picture for.
   *
   * Brands rather than solid glyphs, because these are the logos their owners
   * draw and Stash's own UI uses the same set for the same reason.
   *
   * Both Apple platforms take the Apple logo, which is what they are; the name
   * beside it is what says which of the two this entry is.
   *
   * Undefined rather than a guess, and the caller draws nothing: a name the
   * running Stash's FontAwesome does not have comes back undefined, and an
   * undefined icon handed to Stash's Icon *throws inside a render* — which takes
   * the page down rather than leaving one glyph out.
   */
  function platformIcon(key: PlatformKey): unknown {
    const Brands = PluginApi.libraries.FontAwesomeBrands || {};
    const Solid = PluginApi.libraries.FontAwesomeSolid || {};

    switch (key) {
      case "windows":
        return Brands.faWindows;
      case "macos":
      case "ios":
        return Brands.faApple;
      case "android":
        return Brands.faAndroid;
      case "linux":
        return Brands.faLinux;
      default:
        // "All platforms", which is the default entry rather than a platform
        return Solid.faGlobe;
    }
  }

  /**
   * One entry in the platform dropdown.
   *
   * The label is built here rather than looked up by the renderer, because
   * react-select calls `formatOptionLabel` while it renders and a component's
   * worth of hooks cannot be used in something invoked per option — so the
   * translated words have to already be in the option by the time it gets there.
   */
  interface PlatformOption {
    value: PlatformKey | "default";
    label: string;
    icon: unknown;
  }

  function platformOptions(intl: {
    formatMessage: (descriptor: { id: string }) => string;
  }): PlatformOption[] {
    const current = currentPlatform();

    return [
      {
        value: "default",
        label: intl.formatMessage({ id: "settings.platform.default" }),
        icon: platformIcon("default"),
      },
    ].concat(
      PLATFORM_CHOICES.map((key) => ({
        value: key,
        label:
          platformName(key) +
          (key === current
            ? ` (${intl.formatMessage({ id: "settings.platform.current" })})`
            : ""),
        icon: platformIcon(key),
      }))
    );
  }

  /**
   * Draws one platform option: its icon, then its name.
   *
   * Its own class rather than the player list's `ep-label`, because that one
   * carries a left margin to hold it away from its checkbox — a gap that has no
   * business in a dropdown, where the option starts at the edge of the menu.
   */
  function formatPlatformOption(option: PlatformOption) {
    return (
      <span className="ep-platform-option">
        {option.icon ? <Icon icon={option.icon} fixedWidth /> : null}
        <span>{option.label}</span>
      </span>
    );
  }

  function SettingsModal({ refreshOnSave }: { refreshOnSave?: boolean }) {
    return (
      <PluginIntlProvider>
        <SettingsModalInner refreshOnSave={refreshOnSave} />
      </PluginIntlProvider>
    );
  }

  function SettingsModalInner({ refreshOnSave }: { refreshOnSave?: boolean }) {
    const intl = Intl.useIntl();
    const [show, setShow] = React.useState(false);
    const { settings } = useSettingsState();

    /**
     * What the panel is editing: the settings every platform inherits, or one
     * platform's own.
     *
     * The default is the base and is always editable, so the panel opens on it:
     * "change this everywhere" is what somebody reaches for most, and a platform's
     * own settings are the exception that is asked for. The platform in use is
     * marked in the list, so switching to it takes no thinking.
     */
    const [target, setTarget] = React.useState<PlatformKey | "default">("default");
    /** Whether the selected platform has settings of its own, rather than inheriting */
    const [own, setOwn] = React.useState(false);
    const [draftSettings, setDraftSettings] = React.useState<SettingsState>(() => cloneSettings(settings));

    /** Whether the settings below belong to the selected entry and can be edited */
    const editable = target === "default" || own;
    /** The other side of that: a platform using the default's settings instead */
    const inheriting = !editable;

    /** The platforms, and which of them is selected — built once per render */
    const platformOptionsForPanel = platformOptions(intl);
    const platformChoice = platformOptionsForPanel.find(
      (option) => option.value === target
    );

    /** Points the panel at one of the entries, draft and all */
    const selectTarget = (next: PlatformKey | "default") => {
      setTarget(next);
      setOwn(next !== "default" && hasOverride(storedSettings(), next));
      setDraftSettings(cloneSettings(readSettingsFor(next)));
    };

    React.useEffect(() => {
      if (!show) {
        // Closed: back to where it opens, so the next opening starts from Stash's
        // settings rather than from whatever was left in the draft.
        setTarget("default");
        setOwn(false);
        setDraftSettings(cloneSettings(readSettingsFor("default")));
      }
    }, [settings, show]);

    const openModal = () => {
      selectTarget("default");
      setShow(true);
    };

    const closeModal = () => {
      selectTarget("default");
      setShow(false);
    };

    const togglePlayer = (playerId: string) => {
      setDraftSettings((current) => {
        if (current.singlePlayerMode) {
          return { ...current, singlePlayerId: playerId };
        }

        // excludedPlayerIds is the exclusion list: check = remove from list, uncheck = add to list
        const deselected = current.excludedPlayerIds.includes(playerId)
          ? current.excludedPlayerIds.filter((id) => id !== playerId)
          : [...current.excludedPlayerIds, playerId];

        // Prevent excluding all players (keep at least one visible)
        if (deselected.length >= playerButtons.length) {
          return current;
        }

        return {
          ...current,
          excludedPlayerIds: deselected,
        };
      });
    };

    /**
     * Writes what the panel is showing, to wherever it belongs.
     *
     * Three cases, and the third is the one worth reading twice: confirming a
     * platform that is *inheriting* saves nothing for it — it writes away any
     * settings the platform had, which is what the switch being off means. Turning
     * that switch off and confirming is how a platform goes back to the default.
     */
    const confirmSettings = () => {
      const writing =
        target === "default"
          ? saveDefaultSettings(draftSettings)
          : own
            ? saveStoredSettings(draftSettings, target)
            : saveStoredSettings(null, target);

      // Waited for, and the reload in particular: reloading a page aborts whatever
      // it still has in flight, so closing up straight after asking Stash to save
      // is how a save goes missing.
      writing.then(
        () => {
          setShow(false);
          if (refreshOnSave) {
            window.location.reload();
          }
        },
        () => {
          // The store has reported it. The panel stays open holding the reader's
          // changes, which is now the only place they exist.
        }
      );
    };

    const resetDraftSettings = () => {
      setDraftSettings(cloneSettings(defaultSettings));
    };

    return (
      <>
        <Button
          variant="primary"
          className="external-player-settings-trigger"
          onClick={openModal}
        >
          <Icon icon={faGear} />
          <FormattedMessage id="settings.openButton" />
        </Button>

        <Modal
          show={show}
          onHide={closeModal}
          centered
          dialogClassName="external-player-settings-modal"
          contentClassName="external-player-settings-modal-content"
        >
          <Modal.Header closeButton>
            <Modal.Title>
              <FormattedMessage id="settings.modal.title" />
            </Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <div className="ep-note-block">
              <strong><FormattedMessage id="settings.noteBold" /></strong>
              <FormattedMessage id="settings.noteText" />
            </div>

            {/*
              Which settings are being edited. The default is the base every
              platform inherits; a platform's own settings are the exception, and
              the switch inside is how one is asked for — and how it is given back.
            */}
            <div className="ep-section">
              <div className="ep-heading">
                <FormattedMessage id="settings.platform.title" />
              </div>

              <div className="ep-options">
                {/*
                  Stash's own dropdown — react-select, which is what every other
                  selector in this application is — so this one sits in the panel
                  looking like it was always there. Its separator indicator is
                  stripped for the same reason Stash strips it from its own.

                  The dialog is narrow, so the menu is portalled to the body: a
                  menu inside an `overflow: auto` body is a menu that can be cut
                  off partway down.
                */}
                <Select
                  className="ep-platform-select"
                  classNamePrefix="react-select"
                  inputId="external-player-platform"
                  isSearchable={false}
                  isClearable={false}
                  components={{ IndicatorSeparator: () => null }}
                  menuPortalTarget={document.body}
                  value={platformChoice}
                  options={platformOptionsForPanel}
                  formatOptionLabel={formatPlatformOption}
                  onChange={(option: { value: string } | null) =>
                    selectTarget((option?.value || "default") as PlatformKey | "default")
                  }
                />
                <div className="ep-hint">
                  <FormattedMessage id="settings.platform.hint" />
                </div>
              </div>

              {target !== "default" ? (
                <div className="ep-options">
                  <Form.Check
                    type="switch"
                    id="external-player-platform-own"
                    label={intl.formatMessage({ id: 'settings.platform.own' })}
                    checked={own}
                    onChange={(event: React.ChangeEvent<HTMLInputElement>) => {
                      const next = event.target.checked;
                      setOwn(next);
                      // Off means "use the default": the draft goes back to it, so
                      // what the panel shows is what the platform would actually use.
                      if (!next) setDraftSettings(cloneSettings(readSettingsFor("default")));
                    }}
                  />
                  <div className="ep-hint">
                    <FormattedMessage id="settings.platform.ownHint" />
                  </div>
                </div>
              ) : null}

              {inheriting ? (
                <div className="ep-hint">
                  <FormattedMessage id="settings.platform.inherited" />
                </div>
              ) : null}
            </div>

            <div className="ep-section">
              <div className="ep-heading">
                <FormattedMessage id="settings.entryGroupTitle" />
              </div>

              <div className="ep-options">
                <Form.Check
                  type="switch"
                  id="external-player-show-card-buttons"
                  label={intl.formatMessage({ id: 'settings.showSceneCardButtons' })}
                  disabled={inheriting}
                  checked={draftSettings.showSceneCardButtons}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftSettings((current) => ({
                      ...current,
                      showSceneCardButtons: event.target.checked,
                    }))
                  }
                />
                <div className="ep-hint">
                  <FormattedMessage id="settings.showSceneCardButtonsHint" />
                </div>
              </div>

              <div className="ep-options">
                <Form.Check
                  type="switch"
                  id="external-player-show-detail-buttons"
                  label={intl.formatMessage({ id: 'settings.showSceneDetailButtons' })}
                  disabled={inheriting}
                  checked={draftSettings.showSceneDetailButtons}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftSettings((current) => ({
                      ...current,
                      showSceneDetailButtons: event.target.checked,
                    }))
                  }
                />
                <div className="ep-hint">
                  <FormattedMessage id="settings.showSceneDetailButtonsHint" />
                </div>
              </div>

              <div className="ep-options">
                <Form.Check
                  type="switch"
                  id="external-player-show-toolbar-buttons"
                  label={intl.formatMessage({ id: 'settings.showSceneToolbarButtons' })}
                  disabled={inheriting}
                  checked={draftSettings.showSceneToolbarButtons}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftSettings((current) => ({
                      ...current,
                      showSceneToolbarButtons: event.target.checked,
                    }))
                  }
                />
                <div className="ep-hint">
                  <FormattedMessage id="settings.showSceneToolbarButtonsHint" />
                </div>
              </div>
            </div>

            <div className="ep-section">
              <div className="ep-heading">
                <FormattedMessage id="settings.playerGroupTitle" />
              </div>

              <div className="ep-options">
                <Form.Check
                  type="switch"
                  id="external-player-single-mode"
                  label={intl.formatMessage({ id: 'settings.singlePlayerMode' })}
                  disabled={inheriting}
                  checked={draftSettings.singlePlayerMode}
                  onChange={(event: React.ChangeEvent<HTMLInputElement>) =>
                    setDraftSettings((current) => ({
                      ...current,
                      singlePlayerMode: event.target.checked,
                      singlePlayerId: current.singlePlayerId || playerButtons[0].id,
                      excludedPlayerIds: current.excludedPlayerIds.length ? current.excludedPlayerIds : [...defaultSettings.excludedPlayerIds],
                    }))
                  }
                />
                <div className="ep-hint">
                  <FormattedMessage id="settings.singlePlayerModeHint" />
                </div>
              </div>

              <div className="ep-options">
                <div className="ep-subheading">
                  <FormattedMessage id="settings.playerDisplay" />
                </div>
                <div className="ep-list">
                  {playerButtons.map((button) => {
                    // excludedPlayerIds is the exclusion list; players not in it are checked
                    const checked = draftSettings.singlePlayerMode
                      ? draftSettings.singlePlayerId === button.id
                      : !draftSettings.excludedPlayerIds.includes(button.id);

                    return (
                      <Form.Check
                        key={button.id}
                        type={draftSettings.singlePlayerMode ? "radio" : "checkbox"}
                        id={`external-player-${button.id}`}
                        name="external-player-selection"
                        className="ep-item"
                        disabled={inheriting}
                        checked={checked}
                        onChange={() => togglePlayer(button.id)}
                        label={
                          <span className="ep-label">
                            <img
                              src={`${iconsPath}/${button.id}.webp`}
                              alt={button.name}
                              style={{ height: "1.4em", width: "1.4em" }}
                            />
                            <span>{button.name}</span>
                          </span>
                        }
                      />
                    );
                  })}
                </div>
              </div>
            </div>

            <div className="ep-section">
              {/* Nothing to reset while a platform is inheriting: the draft is the
                  default's, and confirming writes it away rather than saving it. */}
              <Button
                variant="danger"
                disabled={inheriting}
                onClick={resetDraftSettings}
              >
                <FormattedMessage id="settings.reset" />
              </Button>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="secondary" onClick={closeModal}>
              <FormattedMessage id="settings.cancel" />
            </Button>
            <Button variant="primary" onClick={confirmSettings}>
              <FormattedMessage id="settings.confirm" />
            </Button>
          </Modal.Footer>
        </Modal>
      </>
    );
  }

  function ExternalPlayerButtonList({ sceneProps }: { sceneProps: any }) {
    const { settings } = useSettingsState();
    const visiblePlayerButtons = filterPlayerButtons(settings);

    return (
      <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
        {visiblePlayerButtons.map(btn =>
          <Button
            key={btn.id}
            variant="secondary"
            style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
            onClick={() => btn.onClick(getSceneInfo(sceneProps))}
          >
            <img
              src={`${iconsPath}/${btn.id}.webp`}
              alt={btn.name}
              style={{ height: "1.4em", width: "1.4em" }}
            />
            {btn.name}
          </Button>
        )}
      </div>
    );
  }

  function SceneCardExternalPlayerControls({ sceneProps }: { sceneProps: any }) {
    const { settings } = useSettingsState();
    const [isOpen, setIsOpen] = React.useState(false);

    if (settings.singlePlayerMode) {
      const player = getSinglePlayerButton(settings);

      return (
        <OverlayTrigger
          placement="bottom"
          overlay={<Tooltip id={`external-player-tooltip-${player.id}`}>{player.name}</Tooltip>}
        >
          <div>
            <Button
              className="minimal"
              variant="link"
              onClick={() => player.onClick(getSceneInfo(sceneProps))}
            >
              <img
                src={`${iconsPath}/${player.id}.webp`}
                alt={player.name}
                style={{ height: "1.4em", width: "1.4em", verticalAlign: "-0.3em"  }}
              />
            </Button>
          </div>
        </OverlayTrigger>
      );
    }

    const visiblePlayerButtons = filterPlayerButtons(settings);

    return (
      <Dropdown
        className="d-inline-block"
        show={isOpen}
        onToggle={(nextShow: boolean) => setIsOpen(nextShow)}
      >
        <Dropdown.Toggle
          className="minimal"
          // variant="link"
        >
          {createPlayIcon({ style: { height: "1.25em", width: "1.25em", verticalAlign: "-0.3em" } })}
        </Dropdown.Toggle>

        {isOpen && (
          <Dropdown.Menu as={PortalMenu}>
            {visiblePlayerButtons.map(btn =>
              <Dropdown.Item
                key={btn.id}
                onClick={() => btn.onClick(getSceneInfo(sceneProps))}
                style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}
              >
                <img
                  src={`${iconsPath}/${btn.id}.webp`}
                  alt={btn.name}
                  style={{ height: "1.4em", width: "1.4em" }}
                />
                {btn.name}
              </Dropdown.Item>
            )}
          </Dropdown.Menu>
        )}
      </Dropdown>
    );
  }

  function ExternalPlayerTabLabel() {
    return (
      <Nav.Item key="external-player-tab-nav">
        <Nav.Link eventKey="external-player-tab">
          <PluginIntlProvider>
            <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
              {createPlayIcon({ style: { height: "1.25em", width: "1.25em" } })}
              <FormattedMessage id='tab.label' />
            </div>
          </PluginIntlProvider>
        </Nav.Link>
      </Nav.Item>
    );
  }

  function ExternalPlayerTabContent({ sceneProps }: { sceneProps: any }) {
    return (
      <Tab.Pane
        key="external-player-tab-content"
        eventKey="external-player-tab"
      >
        <div className="external-player-tab-header">
          <PluginIntlProvider>
            <h5><FormattedMessage id='tab.header' /></h5>
          </PluginIntlProvider>
          <SettingsModal refreshOnSave />
        </div>
        <ExternalPlayerButtonList sceneProps={sceneProps} />
      </Tab.Pane>
    );
  }

  // Patch the ScenePage to add a new tab for external player launcher
  PluginApi.patch.after(
    "ScenePage.Tabs",
    function (props: any, _: any, original: any) {
      const settings = readSettings();
      if (!settings.showSceneDetailButtons) return original;

      original.props.children.push(
        <ExternalPlayerTabLabel />
      );

      return original;
    }
  );

  // Patch the ScenePage.TabContent to add buttons for open external player
  PluginApi.patch.after(
    "ScenePage.TabContent",
    function (props: any, _: any, original: any) {
      const settings = readSettings();
      if (!settings.showSceneDetailButtons) return original;

      original.props.children.push(
        <ExternalPlayerTabContent sceneProps={props} />
      );

      return original;
    }
  );

  // Add player buttons to the scene detail page toolbar
  PluginApi.patch.after(
    "ScenePage",
    function (props: any, _: any, original: any) {
      // console.log("props:", props, " original:", original);
      const settings = readSettings();
      if (!settings.showSceneToolbarButtons) return original;

      const predicate = (node: any): boolean => {
        if (!(node?.type === "span" && node.props?.className === "scene-toolbar-group")) return false;

        let children = node.props?.children;
        if (!children) return false;

        if (!Array.isArray(children)) {
          children = [children];
        }
        
        return children.some(
          (item: any) => item?.type === "span" && item.props?.children?.type?.displayName === "Dropdown"
        );
      };

      injectIntoReactTree(
        original,
        predicate,
        "prependChild",
        <span><SceneCardExternalPlayerControls sceneProps={props} /></span>
      );

      return original;
    }
  );

  // Patch the Scene Card to add buttons for external players
  PluginApi.patch.after(
    "SceneCard.Popovers",
    function (props: any, _: any, original: any) {
      // console.log("ID:", props.scene.id, " Title:", props.scene.title, " result:", result);

      const settings = readSettings();
      if (!settings.showSceneCardButtons) return original;

      if (!original.props.children) {
        original.props.children = createButtonGroup();
      }

      injectIntoReactTree(
        original,
        (node) => node?.type instanceof Object && node.type?.displayName === "ButtonGroup",
        "appendChild",
        <SceneCardExternalPlayerControls sceneProps={props} />
      );

      return original;
    }
  );

  // Add a settings button at this plugin's location under Settings -> Plugins
  PluginApi.patch.after(
    "SettingGroup",
    function (props: any, _: any, original: any) {
      // console.log("props:", props, " result:", result);
      if (Array.isArray(props?.children)) {
        if (props.children?.[1]?.props?.pluginID === pluginID) {
          injectIntoReactTree(
            props.topLevel,
            (node) => node?.type instanceof Object && node.type?.displayName === "Button",
            "before",
            <SettingsModal />
          );
        }
      }

      return original;
    }
  );

  // Preload locale files to avoid flickering on the first render
  (async () => {
    const res = await loadMessages(defaultLocale)
    if (!res) return;
    console.debug(`[${pluginID}] Preloaded locale messages: ${defaultLocale}`);
  })();

  console.debug(`[${pluginID}] Loaded plugin successfully`);
})();
