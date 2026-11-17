// One key or gamepad slot captures at a time (F016 § 2.1). Focus and click-outside already end a capture in a real
// browser; this makes the rule explicit (and independent of focus) for every KeyCaptureButton and GamepadCaptureButton.

let active: (() => void) | null = null;

/**
 * Registers `stop` as the slot that is capturing now, ending any other capture first. Returns the release function to
 * call when this capture ends (it does nothing if another slot took over meanwhile).
 */
export function claimCapture(stop: () => void): () => void {
  const prev = active;
  active = stop;
  if (prev && prev !== stop) prev();
  return () => {
    if (active === stop) active = null;
  };
}
