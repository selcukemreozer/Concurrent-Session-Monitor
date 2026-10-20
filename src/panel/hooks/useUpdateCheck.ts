import React from "react";
import { useStdout } from "ink";
import { startUpdateCheck, installedVersion } from "../../update.js";

/**
 * The "⬆ vX available" update check (261014-e2u): returns the newer published
 * version, or null.
 *
 * The slowest effect: runs once right after the first render, then every 6 h,
 * off the render thread. startUpdateCheck owns the overlap guard, the unref'd
 * timers and the stopped flag, so its stop function IS this effect's cleanup.
 * It schedules nothing when CSM_UPDATE_CHECK=0/false/off, when stdout is not a
 * TTY, or when the installed version is unknown. It only reads a version; it
 * never installs.
 */
export function useUpdateCheck(): string | null {
  const [updateTo, setUpdateTo] = React.useState<string | null>(null);
  const { stdout } = useStdout();
  React.useEffect(
    () =>
      startUpdateCheck({
        installed: installedVersion(),
        // Ink 8 types useStdout().stdout as a generic writable stream, so the
        // TTY flag is read through a guard. It stays Ink's own stdout (never the
        // global process stream), which keeps the injected test stdout honored.
        isTTY: "isTTY" in stdout && (stdout as { isTTY?: boolean }).isTTY === true,
        onResult: setUpdateTo,
      }),
    [],
  );
  return updateTo;
}
