import { describe, expect, it } from "vitest";
import { formatSpan } from "./duration.js";

/**
 * The duration ladder. Each surface keeps its sub-minute idiom and they all
 * climb the same tiers above a minute, which is the point: a run left looping
 * for a week used to read `604800.0s` on an agent row and `604800s` on the
 * fleet row.
 */
describe("formatSpan", () => {
	it("keeps sub-minute spans in each surface's own idiom", () => {
		expect(formatSpan(340, "precise")).toBe("340ms");
		expect(formatSpan(9_000, "precise")).toBe("9s");
		expect(formatSpan(340, "tenths")).toBe("0.3s");
		expect(formatSpan(4_100, "tenths")).toBe("4.1s");
		expect(formatSpan(0, "seconds")).toBe("0s");
		expect(formatSpan(11_000, "seconds")).toBe("11s");
	});

	it("agrees on minutes and above, with the trailing unit padded", () => {
		for (const style of ["precise", "tenths", "seconds"] as const) {
			expect(formatSpan(72_000, style)).toBe("1m12s");
			expect(formatSpan(372_000, style)).toBe("6m12s");
			expect(formatSpan(3_600_000, style)).toBe("1h00m");
			expect(formatSpan(26_640_000, style)).toBe("7h24m");
			expect(formatSpan(86_400_000, style)).toBe("1d00h");
			expect(formatSpan(273_600_000, style)).toBe("3d04h");
			expect(formatSpan(1_209_600_000, style)).toBe("2w");
			expect(formatSpan(1_468_800_000, style)).toBe("2w3d");
		}
	});

	it("truncates at the top of the ladder rather than rounding up", () => {
		// `59m59s` must not become `1h00m` — the clock is judged by when the next
		// unit is actually reached, not by how close it is.
		expect(formatSpan(3_599_000, "precise")).toBe("59m59s");
		expect(formatSpan(604_799_000, "precise")).toBe("6d23h");
	});

	it("clamps a negative or non-finite span instead of printing it", () => {
		expect(formatSpan(-5_000, "precise")).toBe("0ms");
		expect(formatSpan(Number.NaN, "tenths")).toBe("0.0s");
		expect(formatSpan(Number.POSITIVE_INFINITY, "seconds")).toBe("0s");
	});
});
