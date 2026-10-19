"use client";

import { promptInstall, usePwa } from "./pwa-store";

/** Header button shown only while the browser offers to install P-Dot. */
export function InstallButton() {
  const pwa = usePwa();
  if (!pwa.installable || pwa.standalone) return null;
  return (
    <button type="button" className="button button-small" onClick={() => void promptInstall()}>
      Install app
    </button>
  );
}
