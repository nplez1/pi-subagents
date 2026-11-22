/**
 * schedule-preview.test.ts — the fire instants a schedule string means, per home.
 *
 * Pinned against hand-computed instants, not against the parser that produced
 * them: the point of a preview is to catch a misreading, and a test that asked
 * croner for its own answer would agree with any misreading croner made.
 */

import { describe, expect, it } from "vitest";
import { previewSchedule } from "./schedule-preview.js";

// Saturday 2030-11-23, 12:00 UTC (04:00 in Los Angeles, PST = UTC-8). Far
// future on purpose: `until` is validated against the real clock, as create does.
const NOW = Date.parse("2030-11-23T12:00:00Z");
const iso = (times: number[]) => times.map((at) => new Date(at).toISOString());

describe("cold", () => {
  it("reads a cron expression in the job's zone", () => {
    const preview = previewSchedule({
      schedule: "0 0 9 * * 1",
      timezone: "America/Los_Angeles",
      now: NOW,
      count: 3,
    });
    expect(preview.timezone).toBe("America/Los_Angeles");
    // 9am Monday in LA is 17:00 UTC in PST.
    expect(iso(preview.times)).toEqual([
      "2030-11-25T17:00:00.000Z",
      "2030-12-02T17:00:00.000Z",
      "2030-12-09T17:00:00.000Z",
    ]);
  });

  it("fires an interval one interval after create, not at create", () => {
    const preview = previewSchedule({ schedule: "2h", now: NOW, count: 2 });
    expect(iso(preview.times)).toEqual(["2030-11-23T14:00:00.000Z", "2030-11-23T16:00:00.000Z"]);
  });

  it("stops at the bounds a create would apply", () => {
    const until = previewSchedule({ schedule: "2h", until: "2030-11-23T17:00:00Z", now: NOW });
    expect(until.times).toHaveLength(2);
    const capped = previewSchedule({ schedule: "2h", maxRuns: 1, now: NOW });
    expect(capped.times).toHaveLength(1);
  });

  it("refuses a zone on a schedule that has no wall-clock time to read in it", () => {
    expect(() => previewSchedule({ schedule: "2h", timezone: "Europe/London", now: NOW })).toThrow(/only applies to a cron/);
  });
});

describe("live", () => {
  it("fires an interval as soon as the creating turn ends, then on that phase", () => {
    const preview = previewSchedule({ schedule: "2h", backend: "live", now: NOW, count: 3 });
    expect(iso(preview.times)).toEqual([
      "2030-11-23T12:00:00.000Z",
      "2030-11-23T14:00:00.000Z",
      "2030-11-23T16:00:00.000Z",
    ]);
  });

  it("refuses cron by name, pointing at the home that has it", () => {
    expect(() => previewSchedule({ schedule: "0 0 9 * * 1", backend: "live", now: NOW })).toThrow(/cold backend only/);
  });

  it("drops fires an unbounded loop would not live to make, and says why", () => {
    const preview = previewSchedule({ schedule: "2d", backend: "live", now: NOW });
    // now, +2d, +4d, +6d — +8d is past the 7-day TTL.
    expect(preview.times).toHaveLength(4);
    expect(preview.notes.join(" ")).toMatch(/expires 7 days after create/);
    const bounded = previewSchedule({ schedule: "2d", backend: "live", maxRuns: 5, now: NOW });
    expect(bounded.times).toHaveLength(5);
  });
});
