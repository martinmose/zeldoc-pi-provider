/**
 * Read the optional `zeldoc.models` allowlist from Pi's settings file.
 *
 * Pi has no dedicated extension-settings API, so the allowlist lives next to
 * Pi's own keys in `~/.pi/agent/settings.json`:
 *
 * ```json
 * { "zeldoc.models": ["zdev"] }
 * ```
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const SETTINGS_PATH = join(homedir(), ".pi", "agent", "settings.json");

/** Settings key holding model-id substrings to expose. */
export const ALLOWLIST_SETTING = "zeldoc.models";

/** Read `~/.pi/agent/settings.json` as a record; `{}` on any failure. */
export function readSettings(): Record<string, unknown> {
  try {
    if (!existsSync(SETTINGS_PATH)) return {};
    const parsed: unknown = JSON.parse(readFileSync(SETTINGS_PATH, "utf-8"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** Return the allowlist patterns, or `undefined` when none are configured. */
export function readZeldocAllowlist(
  settings: Record<string, unknown>,
): string[] | undefined {
  const value = settings[ALLOWLIST_SETTING];
  if (!Array.isArray(value)) return undefined;
  const patterns = value
    .filter((v): v is string => typeof v === "string")
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
  return patterns.length > 0 ? patterns : undefined;
}
