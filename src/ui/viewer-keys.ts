/**
 * viewer-keys.ts — Scroll input matchers for the conversation viewer.
 *
 * Resolves `tui.select.*` through the user's keybindings when pi provides a
 * manager, falling back to the previous hardcoded keys otherwise. The viewer's
 * k/j and shift+arrow aliases always work alongside whatever is bound.
 *
 * Mouse wheel arrives here only as a fallback. A host whose alt screen
 * normalizes mouse events dispatches the wheel to the viewer's `handleMouse`
 * first, and that is the path that scrolls; these byte matchers cover a host that
 * does not — including the pi-tui version this package typechecks against, which
 * has no `handleMouse` at all — where the unclaimed sequence reaches the focused
 * component as raw bytes.
 */

import { type KeyId, matchesKey } from "@earendil-works/pi-tui";

/** Lines per wheel notch on the raw-byte path, which cannot see pi's acceleration. */
const WHEEL_LINES = 1;
/** pi-tui's `ALT_WHEEL_SCROLL_MULTIPLIER` — Alt multiplies a notch. */
const ALT_WHEEL_SCROLL_MULTIPLIER = 5;
const SGR_WHEEL = /^\[<(\d+);(\d+);(\d+)[Mm]$/;

/** Button code from an SGR (`\x1b[<64;x;yM`) or legacy (`\x1b[M` + 3 bytes) mouse report. */
function wheelButton(data: string): number | undefined {
  if (!data.startsWith("\x1b")) return undefined;
  // Split off the ESC so no control character sits inside a regex (biome's noControlCharactersInRegex).
  const body = data.slice(1);
  if (body.length === 5 && body.startsWith("[M")) return body.charCodeAt(2) - 32;
  const sgr = SGR_WHEEL.exec(body);
  if (!sgr) return undefined;
  const code = Number.parseInt(sgr[1] ?? "", 10);
  return Number.isNaN(code) ? undefined : code;
}

/** Signed line delta for a vertical wheel event, or `undefined` for anything else. */
function parseWheel(data: string): number | undefined {
  const button = wheelButton(data);
  if (button === undefined || (button & 64) === 0) return undefined; // 64 = wheel
  const direction = button & 3;
  if (direction > 1) return undefined; // 2/3 = wheel left/right
  const lines = WHEEL_LINES * ((button & 8) !== 0 ? ALT_WHEEL_SCROLL_MULTIPLIER : 1);
  return direction === 0 ? -lines : lines;
}

/** The `tui.select.*` keybinding ids the viewer resolves. */
export type ViewerScrollKeybinding =
  | "tui.select.up"
  | "tui.select.down"
  | "tui.select.pageUp"
  | "tui.select.pageDown";

/** Structural subset of pi-tui's `KeybindingsManager` (which satisfies it). */
export interface ViewerKeybindings {
  matches(data: string, keybinding: ViewerScrollKeybinding): boolean;
}

export interface ViewerKeys {
  scrollUp(data: string): boolean;
  scrollDown(data: string): boolean;
  pageUp(data: string): boolean;
  pageDown(data: string): boolean;
  /** Signed line delta for a wheel event, or `undefined` when `data` is not one. */
  wheelLines(data: string): number | undefined;
}

export function createViewerKeys(keybindings?: ViewerKeybindings): ViewerKeys {
  const matches = (data: string, id: ViewerScrollKeybinding, fallback: KeyId): boolean =>
    keybindings ? keybindings.matches(data, id) : matchesKey(data, fallback);
  return {
    scrollUp: (data) => matches(data, "tui.select.up", "up") || matchesKey(data, "k"),
    scrollDown: (data) => matches(data, "tui.select.down", "down") || matchesKey(data, "j"),
    pageUp: (data) => matches(data, "tui.select.pageUp", "pageUp") || matchesKey(data, "shift+up"),
    pageDown: (data) => matches(data, "tui.select.pageDown", "pageDown") || matchesKey(data, "shift+down"),
    wheelLines: parseWheel,
  };
}
