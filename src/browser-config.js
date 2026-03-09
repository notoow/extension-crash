import os from "node:os";
import path from "node:path";

const LOCAL_APP_DATA = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");

const WINDOWS_BROWSER_CONFIGS = {
  chrome: {
    key: "chrome",
    displayName: "Google Chrome",
    executableCandidates: [
      path.join("C:\\", "Program Files", "Google", "Chrome", "Application", "chrome.exe"),
      path.join("C:\\", "Program Files (x86)", "Google", "Chrome", "Application", "chrome.exe"),
    ],
    userDataDir: path.join(LOCAL_APP_DATA, "Google", "Chrome", "User Data"),
  },
  edge: {
    key: "edge",
    displayName: "Microsoft Edge",
    executableCandidates: [
      path.join("C:\\", "Program Files", "Microsoft", "Edge", "Application", "msedge.exe"),
      path.join("C:\\", "Program Files (x86)", "Microsoft", "Edge", "Application", "msedge.exe"),
    ],
    userDataDir: path.join(LOCAL_APP_DATA, "Microsoft", "Edge", "User Data"),
  },
  brave: {
    key: "brave",
    displayName: "Brave",
    executableCandidates: [
      path.join("C:\\", "Program Files", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
      path.join("C:\\", "Program Files (x86)", "BraveSoftware", "Brave-Browser", "Application", "brave.exe"),
    ],
    userDataDir: path.join(LOCAL_APP_DATA, "BraveSoftware", "Brave-Browser", "User Data"),
  },
};

export function getBrowserConfig(browserKey = "chrome") {
  const config = WINDOWS_BROWSER_CONFIGS[browserKey];

  if (!config) {
    throw new Error(`Unsupported browser "${browserKey}". Use one of: ${Object.keys(WINDOWS_BROWSER_CONFIGS).join(", ")}.`);
  }

  return config;
}

export function listSupportedBrowsers() {
  return Object.values(WINDOWS_BROWSER_CONFIGS);
}
