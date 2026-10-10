// Which dedicated version of the site to render.
//
// Standing build rule (Max, 2026-09-13; vault Context/tech-stack.md §Build
// standard): every page ships a desktop version and a mobile version, each
// with its own composition, over one shared data and logic layer. Responsive
// CSS tunes sizes inside a version; it is not a substitute for the second one.
// This provider decides which version a reader gets.
//
// Detection is by viewport width, because width is what a layout has to fit. A
// user-agent string says nothing about a narrow desktop window or a tablet on
// its side. A reader can override the choice from the footer, and the override
// is remembered on this device.

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

export type Device = "desktop" | "mobile";

// Up to and including this width, the mobile version. Matches Tailwind's `md`
// boundary so the two systems never disagree about what "mobile" means.
export const MOBILE_MAX_WIDTH = 767;
const STORAGE_KEY = "litmus.device";
const QUERY = `(max-width: ${MOBILE_MAX_WIDTH}px)`;

// A reader's explicit choice always wins over detection.
export function pickDevice(isNarrow: boolean, override: Device | null): Device {
  if (override === "desktop" || override === "mobile") return override;
  return isNarrow ? "mobile" : "desktop";
}

function readOverride(): Device | null {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "desktop" || v === "mobile" ? v : null;
  } catch {
    // Storage blocked (private mode, disabled cookies): no remembered choice,
    // so detection decides. That is the correct fallback, not an error.
    return null;
  }
}

function writeOverride(value: Device | null): void {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Storage blocked: the choice still applies for this visit via state.
  }
}

interface DeviceContextValue {
  device: Device;
  detected: Device;
  override: Device | null;
  setOverride: (value: Device | null) => void;
}

const DeviceContext = createContext<DeviceContextValue | null>(null);

export function DeviceProvider({ children }: { children: ReactNode }) {
  const [isNarrow, setIsNarrow] = useState(() => typeof window !== "undefined" && window.matchMedia(QUERY).matches);
  const [override, setOverrideState] = useState<Device | null>(() => readOverride());

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setIsNarrow(e.matches);
    setIsNarrow(mq.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  const value = useMemo<DeviceContextValue>(
    () => ({
      device: pickDevice(isNarrow, override),
      detected: pickDevice(isNarrow, null),
      override,
      setOverride: (next) => {
        writeOverride(next);
        setOverrideState(next);
      },
    }),
    [isNarrow, override],
  );

  return <DeviceContext.Provider value={value}>{children}</DeviceContext.Provider>;
}

export function useDevice(): DeviceContextValue {
  const ctx = useContext(DeviceContext);
  if (!ctx) throw new Error("useDevice must be used inside <DeviceProvider>");
  return ctx;
}
