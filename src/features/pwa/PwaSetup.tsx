"use client";

import { useEffect } from "react";
import { startPwa } from "./pwa-store";

/** Registers the service worker once per page load. Renders nothing. */
export function PwaSetup() {
  useEffect(() => startPwa(), []);
  return null;
}

/**
 * Runs before React loads: Chrome may offer installation early, and the offer
 * is lost unless something keeps it. startPwa() picks it up from here.
 */
export const EARLY_INSTALL_SCRIPT =
  "window.addEventListener('beforeinstallprompt',function(e){e.preventDefault();window.__pdotInstallPrompt=e;});";
