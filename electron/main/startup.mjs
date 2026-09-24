/**
 * The startup sequence: everything that runs once the app is ready (main.mjs calls startApp from app.whenReady).
 *
 * The phases run strictly in this order, and so do the steps inside them: consent before anything starts, recovery
 * before anything writes, app.config before appearance, appearance before the first window. Where a step depends on an
 * earlier one, it says so.
 */
import { app, BrowserWindow } from "electron";
import { getAssetDir, getWorkingDir, initEngine } from "../tools/aiToolkit.mjs";
// Reports at startup whether the Rust sidecar is enabled, active, or unavailable — see warmUp.
// setSessionPolicyProvider declares the roots the runtime confines commands to; see startServices.
import { setSessionPolicyProvider as setRuntimeSessionPolicy, warmUp as warmUpRustRuntime } from "../tools/rustRuntime.mjs";
// Sub-agent scheduling in the runtime (Stage 4b). Opt-in; see subagentBridge.mjs.
import { subagentsEnabled } from "../agent/subagentBridge.mjs";
// First-launch agreement to the Privacy Policy and the Terms of Service; gates every window. See legal/consentWindow.mjs.
import { ensureLegalConsent } from "../legal/consentWindow.mjs";
import { appUserModelId, ensureDevStartMenuShortcut, notificationIconPath, windowIconPath } from "../appIdentity.mjs";
import { registerAppearance } from "../appearance.mjs";
import { registerSkins } from "../skins/store.mjs";
import { registerSkinPackages, registerSkinProtocol } from "../skins/engine.mjs";
import { pruneUsageLog } from "../store/usageLogStore.mjs";
import { initAutomation, setAutomationNotifier } from "../automation/paths.mjs";
import { initPlugins } from "../plugins/paths.mjs";
import { initBackground, isBackgroundLaunch } from "../services/background.mjs";
import { registerAppProtocol } from "./appProtocol.mjs";
import {
  createWindow,
  crashPolicyFor,
  ensureMainWindow,
  focusMainWindow,
  getMainWindow,
  loadAppInto,
  quitApp,
  registerWebviewWindowOpen,
} from "./window.mjs";
import { flushPendingDeepLink, hasPendingDeepLink } from "./deepLinks.mjs";
import { runStartupRecovery } from "./startupRecovery.mjs";
import { syncAssetRoot } from "./assetRoot.mjs";
import { registerAppConfig } from "../ipc/appConfigIpc.mjs";
import { registerAiTools } from "../ipc/aiToolsIpc.mjs";
import { registerProjectSkills } from "../ipc/projectSkillsIpc.mjs";
import { registerRecovery } from "../ipc/recoveryIpc.mjs";
import { registerSandbox } from "../ipc/sandboxIpc.mjs";
import { registerTerminal } from "../ipc/terminalIpc.mjs";
import { registerLlmProxy } from "../ipc/llmIpc.mjs";
import { registerUploadProxy } from "../ipc/uploadIpc.mjs";
import { registerLocalLlm } from "../ipc/localLlmIpc.mjs";
import { registerWindowControls } from "../ipc/windowControlsIpc.mjs";
import { registerAgentStore } from "../ipc/agentStoreIpc.mjs";
import { registerIntegrity } from "../ipc/integrityIpc.mjs";
import { registerMemoryFiles } from "../ipc/memoryFilesIpc.mjs";
import { registerNotifications } from "../ipc/notificationIpc.mjs";
import { registerGoogleAuth } from "../ipc/googleAuthIpc.mjs";
import { registerUpdater } from "../ipc/updaterIpc.mjs";
import { registerBrowserAutomation } from "../ipc/browserAutomationIpc.mjs";
import { registerPlugins } from "../ipc/pluginsIpc.mjs";
import { registerUsageLog } from "../ipc/usageLogIpc.mjs";
import { registerMcp } from "../ipc/mcpIpc.mjs";
import { registerBackground } from "../ipc/backgroundIpc.mjs";

export async function startApp() {
  applyAppIdentity();
  // First launch: the Privacy Policy and the Terms of Service are agreed to before anything else starts — no
  // service, no window. Declining (or closing the screen) ends the launch. Asked again only when the
  // documents' version changes (LEGAL_VERSION in legal/consentState.mjs).
  if (!(await ensureLegalConsent({ iconPath: windowIconPath() }))) {
    app.quit();
    return;
  }
  // What the previous session left behind — its session lock, temp files, orphaned command trees — before anything writes.
  runStartupRecovery();
  registerProtocolsAndAppearance();
  startServices();
  openFirstWindow();
}

/** How the OS identifies the app: the Windows AppUserModelID, and the Dock icon of a macOS dev launch. */
function applyAppIdentity() {
  // Windows: toasts and taskbar grouping key off the AppUserModelID; it must match the Start Menu shortcut
  // (installer-written when packaged, written here for a dev launch). See appIdentity.mjs. No side effects on macOS/Linux.
  ensureDevStartMenuShortcut();
  app.setAppUserModelId(appUserModelId());
  // macOS dev: `electron .` runs the stock Electron.app, whose Dock icon is the Electron atom; the packaged .app has its own icns.
  if (process.platform === "darwin" && windowIconPath()) app.dock?.setIcon(windowIconPath());
}

/** The app:// and skin:// protocols, app.config and appearance: all in place before the first window exists. */
function registerProtocolsAndAppearance() {
  // The splash screen has been removed: the app loads the entry (`/`) directly, and the entry page routes to /agent or /login based on login state.
  // The main window shows as soon as the first content frame is ready (ready-to-show); with no splash, dismissSplash is equivalent to directly showing the main window.
  registerAppProtocol();
  // Skin packages: the Rust engine's IPC surface and the skin:// file protocol (electron/skins/engine.mjs).
  registerSkinPackages();
  registerSkinProtocol();
  registerAppConfig();
  // After registerAppConfig (it reads [ui] from the loaded config) and before the first window is
  // created, so nativeTheme.themeSource is already right when that window picks its background.
  registerAppearance();
  registerSkins();
}

/** IPC for every renderer bridge, and the services behind it: tools, sandbox, models, stores, integrations, automation. */
function startServices() {
  registerAiTools();
  registerProjectSkills();
  registerRecovery({ crashPolicyFor, loadAppInto });
  registerSandbox();
  // Before the sidecar starts, not after: the media root is one of the roots the runtime is confined to, and a
  // handshake that ran first would declare a session without it. Synchronous and never fatal (see assetRoot.mjs),
  // so moving it ahead of the warm-up costs nothing.
  syncAssetRoot();
  // What this session may touch. Declaring it is what ARMS the runtime's sandbox: `session_policy.rs` confines
  // every command to these roots (plus the command's own working directory and the system toolchain), and a
  // host that declares nothing leaves every command unconfined — which is what the app did until now.
  //
  // A function rather than a value because the sidecar can respawn at any point in the session, and the user
  // may have changed project since it last started. The filesystem half of the ceiling is frozen per handshake
  // by design, so what matters is that each handshake sees the CURRENT workspace.
  //
  // The media library is declared READ-ONLY rather than as a second workspace. Both are directories the agent
  // may look at; only one is a directory it may change. The host's own file tools already draw that line
  // (`resolvePath` refuses to write to the asset root), and declaring the library as a workspace root made the
  // sandbox disagree with them — commands could overwrite the user's media.
  setRuntimeSessionPolicy(() => ({
    workspaceRoots: [getWorkingDir()],
    readonlyRoots: [getAssetDir()],
  }));
  // Start the Rust sidecar now rather than on the first tool call, so its state is reported once at
  // boot instead of being inferred from behaviour. Fire-and-forget and never fatal: with the flag off it
  // prints one line and starts nothing. Not fatal here either: a failure is reported by the tools that
  // need it (they have no JS fallback since 2.0), not by refusing to open the window.
  void warmUpRustRuntime()
    .then(() => {
      // Said plainly, because the sub-agent path is opt-in and its absence is otherwise invisible:
      // the app behaves identically either way, right up until you look for which scheduler ran.
      console.info(
        subagentsEnabled()
          ? "[rust-runtime] sub-agent scheduling: RUNTIME (ZERAIX_RUST_SUBAGENTS)"
          : "[rust-runtime] sub-agent scheduling: renderer (set ZERAIX_RUST_SUBAGENTS=on to use the runtime)",
      );
    })
    .catch((e) => console.warn("[rust-runtime] warm-up failed:", e?.message ?? e));
  registerTerminal();
  // Select the command-execution engine (start a qemu VM in the background if hardware virtualization is available, otherwise keep running natively on the host).
  // Runs asynchronously in the background; on failure it silently falls back to native without affecting startup.
  initEngine();
  registerLlmProxy();
  registerUploadProxy();
  registerLocalLlm({ getWindow: getMainWindow });
  registerWindowControls();
  registerAgentStore();
  registerIntegrity();
  registerMemoryFiles();
  // System-level notifications (renderer window.notification.* -> queue/coalesce/throttle -> OS notification; click relays route:navigate)
  const notificationService = registerNotifications({
    getWindow: getMainWindow,
    // Background mode: a click on an automation notification must open the app, not fall on the floor.
    ensureWindow: ensureMainWindow,
    iconPath: notificationIconPath(),
  });
  // Automation uses this to nudge the user when a run is waiting on their approval.
  setAutomationNotifier(notificationService);
  // Google login (RFC 8252 native flow: loopback service + PKCE + system browser -> id_token handed back to the renderer)
  registerGoogleAuth();
  // Auto-update (GitHub Releases feed; renderer drives check/download/install via window.updater)
  registerUpdater();
  registerBrowserAutomation();
  // Plugin marketplace. initPlugins() enforces the cached kill-list synchronously, before any
  // capability can be offered — a revoked plugin must not be live for the seconds a network refresh
  // would take. The renderer supplies the registry origin afterwards via plugins:configure.
  initPlugins();
  registerPlugins();
  // Token-usage log (off by default). Pruning old day files runs regardless of the switch: a log the
  // user turned on once and forgot should not still be on disk a year later.
  registerUsageLog();
  void pruneUsageLog();
  // External MCP servers: configuration + trust live in the renderer's settings panel, the protocol
  // itself entirely here. Approved servers are connected in the background, never blocking startup.
  registerMcp();
  registerWebviewWindowOpen();
  registerBackground();
  // Automation subsystem: fix the storage root and open/migrate the run-state database.
  // A failure here must not block startup -- the rest of the app is fully usable without it.
  try {
    initAutomation();
  } catch (e) {
    console.error("[automation] initialization failed; automation disabled this session:", e);
  }
}

/** Tray-resident mode, then the first window unless this is a headless autostart, then what was waiting for a window. */
function openFirstWindow() {
  // Tray-resident mode: creates the tray when background mode is on (or when this is an autostart
  // launch) and re-applies the login-item registration.
  const background = initBackground({ onOpen: focusMainWindow, onQuit: quitApp });

  // Autostart launches come up headless -- tray only, no window. Any deep link arriving later, a
  // tray click, or macOS dock activate creates the window on demand via focusMainWindow.
  // `background.active` is false when no tray could be created: staying headless there would leave
  // an invisible, unreachable process, so fall back to showing the window normally.
  const headless = isBackgroundLaunch() && background.active && !hasPendingDeepLink();
  if (headless) {
    console.log("[background] started headless (tray only)");
    // macOS: keep the dock icon out of the way until the user actually opens a window.
    if (process.platform === "darwin") app.dock?.hide();
  } else {
    createWindow();
  }

  // A deep link present at cold start (Windows/Linux argv / an early open-url on macOS) is processed once the window is ready.
  flushPendingDeepLink();

  // macOS: recreate the window when the Dock icon is clicked and there are no windows
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
}
