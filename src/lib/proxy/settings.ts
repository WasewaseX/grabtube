import { existsSync, readFileSync } from "node:fs";

export const DATA_DIR = "/home/z/my-project/data";
export const SETTINGS_PATH = `${DATA_DIR}/settings.json`;
export const COOKIES_PATH = `${DATA_DIR}/cookies.txt`;

export interface Settings {
  extraProxies?: string[];
  cookies?: string | null; // Netscape cookies.txt content
  updatedAt?: number;
}

export function loadSettings(): Settings {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    return JSON.parse(readFileSync(SETTINGS_PATH, "utf8")) as Settings;
  } catch {
    return {};
  }
}
