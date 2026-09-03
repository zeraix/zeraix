/**
 * The consent screen's only bridge: fetch its text, and answer. Nothing else is exposed — the page is a static
 * file with two buttons, and it must stay unable to do anything but say yes or no.
 */
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("consent", {
  /** The screen's strings in the chosen language, plus the two document URLs. */
  strings: () => ipcRenderer.invoke("legal:strings"),
  accept: () => ipcRenderer.invoke("legal:accept"),
  decline: () => ipcRenderer.invoke("legal:decline"),
});
