import { describe, expect, it } from "vite-plus/test";

import { STATUS_PULSE_STEPS } from "./statusPulseCadence";

describe("StatusPulse", () => {
  it("uses eight discrete timer steps over the documented 1.9 second cadence", () => {
    expect(STATUS_PULSE_STEPS).toHaveLength(8);
    expect(STATUS_PULSE_STEPS.map((step) => step.opacity)).toEqual([
      0.875, 0.75, 0.625, 0.5, 0.625, 0.75, 0.875, 1,
    ]);
    expect(STATUS_PULSE_STEPS.reduce((total, step) => total + step.delayMs, 0)).toBe(1900);
  });
});
