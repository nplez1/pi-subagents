/**
 * duration.ts — the one place a span of time becomes a string.
 *
 * There are three surfaces that print durations and they do not read alike on
 * purpose: the workflow header and phase rows print milliseconds (`340ms`,
 * `9s`, `1m12s`), agent rows print one decimal of a second (`4.1s`), and the
 * fleet row prints whole seconds (`11s`). What they all shared was an upper
 * bound — none of them climbed past minutes, so a workflow left looping for a
 * week reported `604800.0s` and the fleet row `604800s`, which is a number
 * nobody can read at a glance.
 *
 * So the *ladder* lives here and each surface keeps its own short form:
 *
 *   precise   340ms · 9s · 1m12s · 7h04m · 3d04h · 2w3d
 *   tenths    0.3s  · 4.1s · 1m12s · 7h04m · 3d04h · 2w3d
 *   seconds   1s    · 11s  · 1m12s · 7h04m · 3d04h · 2w3d
 *
 * Two digits are kept on the trailing unit (`7h04m`, not `7h4m`) because these
 * strings are read in columns, and the ladder stops at weeks: a run long enough
 * to want months reads `9w3d`, which is both true and more precise than a month
 * count. Nothing here rounds up into a unit that would hide the work — `59m59s`
 * stays `59m59s` rather than becoming `1h00m`.
 */

/** How the sub-minute part of a span reads. Above a minute every style agrees. */
export type DurationStyle =
  /** `340ms`, `9s` — the workflow surfaces' idiom. */
  | "precise"
  /** `0.3s`, `4.1s` — agent rows, matching what they have always shown. */
  | "tenths"
  /** `1s`, `11s` — the fleet row's whole seconds. */
  | "seconds";

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

const pad2 = (n: number) => n.toString().padStart(2, "0");

/**
 * A span of a minute or more, as `1m12s` / `7h04m` / `3d04h` / `2w3d`.
 *
 * Units are truncated rather than rounded at the top of the ladder: a run 3
 * days and 23 hours in reads `3d23h` until it crosses into `4d00h`, which is
 * what someone watching a clock expects. The trailing unit is zero-padded so
 * the strings keep a stable width in a column.
 */
function fromSeconds(totalSeconds: number): string {
  if (totalSeconds < MINUTE) return `${totalSeconds}s`;
  if (totalSeconds < HOUR) {
    return `${Math.floor(totalSeconds / MINUTE)}m${pad2(totalSeconds % MINUTE)}s`;
  }
  if (totalSeconds < DAY) {
    return `${Math.floor(totalSeconds / HOUR)}h${pad2(Math.floor((totalSeconds % HOUR) / MINUTE))}m`;
  }
  if (totalSeconds < WEEK) {
    return `${Math.floor(totalSeconds / DAY)}d${pad2(Math.floor((totalSeconds % DAY) / HOUR))}h`;
  }
  const weeks = Math.floor(totalSeconds / WEEK);
  const days = Math.floor((totalSeconds % WEEK) / DAY);
  return days === 0 ? `${weeks}w` : `${weeks}w${days}d`;
}

/**
 * Format a duration in milliseconds.
 *
 * Negative spans are clamped to zero: they come from clock arithmetic across a
 * pause, not from a run that ran backwards, and `-0ms` in a column is noise.
 */
export function formatSpan(ms: number, style: DurationStyle = "precise"): string {
  const safe = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  if (safe < 1000) {
    if (style === "precise") return `${Math.round(safe)}ms`;
    // Whole seconds round to the nearest one, as they always have: `600ms` is
    // `1s` here and `1400ms` is `1s`, so the two boundaries agree.
    if (style === "seconds") return `${Math.round(safe / 1000)}s`;
    return `${(safe / 1000).toFixed(1)}s`;
  }
  // One rounding step, at the sub-minute boundary, so `59_600ms` reads `1m00s`
  // rather than `59s` in one style and `60s` in another.
  const seconds = Math.round(safe / 1000);
  if (seconds < MINUTE) {
    if (style === "precise") return `${seconds}s`;
    if (style === "seconds") return `${seconds}s`;
    return `${(safe / 1000).toFixed(1)}s`;
  }
  return fromSeconds(seconds);
}
