import { describe, expect, it } from "vitest";
import { pickDevice } from "./device.tsx";

describe("pickDevice", () => {
  it("serves the mobile version on a narrow viewport and the desktop version otherwise", () => {
    expect(pickDevice(true, null)).toBe("mobile");
    expect(pickDevice(false, null)).toBe("desktop");
  });

  it("lets a reader's explicit choice override detection in both directions", () => {
    expect(pickDevice(true, "desktop")).toBe("desktop");
    expect(pickDevice(false, "mobile")).toBe("mobile");
  });

  it("ignores a corrupt stored value rather than trusting it", () => {
    expect(pickDevice(true, "tablet" as never)).toBe("mobile");
  });
});
