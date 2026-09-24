import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { join } from "node:path";

async function executable(path: string): Promise<boolean> {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolves the Chrome/Chromium binary browser-backed tests drive. Honours
 * `NITELY_CHROME_PATH` first so a sandbox can point at a bundled build.
 */
export async function chromeExecutablePath(): Promise<string> {
  const configured = process.env.NITELY_CHROME_PATH?.trim();
  if (configured) {
    if (await executable(configured)) return configured;
    throw new Error(`NITELY_CHROME_PATH is not executable: ${configured}`);
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    ...(process.env.PROGRAMFILES
      ? [join(process.env.PROGRAMFILES, "Google", "Chrome", "Application", "chrome.exe")]
      : []),
    ...(process.env.LOCALAPPDATA
      ? [
          join(
            process.env.LOCALAPPDATA,
            "Google",
            "Chrome",
            "Application",
            "chrome.exe",
          ),
        ]
      : []),
  ];
  for (const candidate of candidates) {
    if (await executable(candidate)) return candidate;
  }
  throw new Error(
    "Chrome or Chromium is required for browser-backed console checks; set NITELY_CHROME_PATH",
  );
}
