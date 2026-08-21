// CommonJS on purpose (.cjs extension), regardless of the root package.json's
// "type": "module" — electron-updater's CJS shape is the path of least
// friction for the main process, and this file has no reason to be ESM.
const { app, BrowserWindow, dialog } = require("electron");
const path = require("node:path");

// Mirrors src/server/index.ts's own PORT resolution exactly, so the window
// can never load a different URL than the port the server actually bound —
// there's deliberately no separate "Electron port" setting.
const PORT = process.env.PORT ? Number(process.env.PORT) : 3000;

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    title: "CEO Agent OS",
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
  });
  mainWindow.loadURL(`http://localhost:${PORT}/`);
}

function setupAutoUpdate() {
  if (!app.isPackaged) return;
  const { autoUpdater } = require("electron-updater");

  autoUpdater.on("error", (err) => {
    console.error("Auto-update error:", err);
  });
  autoUpdater.on("update-downloaded", () => {
    dialog
      .showMessageBox(mainWindow, {
        type: "info",
        buttons: ["Restart now", "Later"],
        title: "Update ready",
        message: "A new version of CEO Agent OS has been downloaded. Restart to apply it?",
      })
      .then(({ response }) => {
        if (response === 0) autoUpdater.quitAndInstall();
      });
  });

  autoUpdater.checkForUpdatesAndNotify();
  // This app runs a background scheduler and is expected to stay open for
  // long stretches — recheck periodically rather than only on launch.
  setInterval(() => autoUpdater.checkForUpdatesAndNotify(), 4 * 60 * 60 * 1000);
}

app.whenReady().then(async () => {
  // Must be set before the server module is imported — every persisted
  // store (run history, schedules, OAuth tokens, settings) resolves its
  // path relative to this at import time.
  process.env.CEO_AGENT_DATA_DIR = app.getPath("userData");

  try {
    // app.getAppPath() is the project root in dev (electron run from there)
    // and the unpacked app directory once packaged (asar: false, see
    // electron-builder.yml) — same relative layout either way.
    const serverEntry = path.join(app.getAppPath(), "dist", "server", "index.js");
    const { startServer } = await import(require("node:url").pathToFileURL(serverEntry).href);
    await startServer();
  } catch (err) {
    dialog.showErrorBox("CEO Agent OS failed to start", err instanceof Error ? err.message : String(err));
    app.quit();
    return;
  }

  createWindow();
  setupAutoUpdate();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// The server binds a fixed port (3000) — a second instance would crash on
// EADDRINUSE instead of just showing the user their already-running app.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}
