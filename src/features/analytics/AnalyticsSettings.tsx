"use client";

import { useEffect, useState } from "react";

export function AnalyticsSettings() {
  const [available, setAvailable] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/analytics/status", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) return;
      const data = await response.json() as { available: boolean; enabled: boolean };
      setAvailable(data.available);
      setEnabled(data.enabled);
    }).catch(() => {});
  }, []);

  async function change(next: boolean) {
    setBusy(true);
    try {
      const response = await fetch("/api/analytics/consent", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: next }),
      });
      if (response.ok) {
        setEnabled(next);
        window.dispatchEvent(new CustomEvent("pdot-analytics-consent", { detail: next }));
      }
    } finally { setBusy(false); }
  }

  if (!available) return <p className="small muted">Optional product analytics are not configured.</p>;
  return <label className="check-row">
    <input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => void change(event.target.checked)} />
    <span>Share limited product analytics to help improve P-Dot</span>
  </label>;
}
