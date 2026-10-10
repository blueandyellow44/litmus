// "Desktop site / Mobile site". Overrides width detection and is remembered on
// this device (lib/device.tsx). Choosing the version detection would pick anyway
// clears the override, so a reader who switches back is not pinned forever.

import { useDevice } from "../lib/device.tsx";
import { CONTROL } from "./meta.tsx";

export function DeviceSwitch({ className = "" }: { className?: string }) {
  const { device, detected, setOverride } = useDevice();
  const other = device === "mobile" ? "desktop" : "mobile";
  return (
    <button
      type="button"
      onClick={() => setOverride(other === detected ? null : other)}
      className={`underline decoration-1 underline-offset-2 hover:text-ink inline-flex items-center ${CONTROL} ${className}`}
    >
      {other === "desktop" ? "Desktop site" : "Mobile site"}
    </button>
  );
}
