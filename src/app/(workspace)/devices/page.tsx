import type { Metadata } from "next";
import Link from "next/link";
import { ThisDevice } from "@/features/pwa/ThisDevice";
import { requireAuth } from "@/server/auth/session";

export const metadata: Metadata = { title: "Devices · P-Dot" };

// The planned pairing flow, shown as a preview. See docs/decisions/0010-pwa-and-device-pairing.md.
const PAIRING_STEPS = [
  "Install P-Dot on the laptop or phone you want to pair.",
  "Create a pairing code here. It works once and expires after 10 minutes.",
  "Enter the code on the other device.",
  "Check the device name and approve it here. You can remove it at any time.",
];

export default async function DevicesPage() {
  await requireAuth("/devices");

  return (
    <main className="page stack">
      <div>
        <h1>Devices</h1>
        <p className="muted">
          Pair your own laptop and phone so P-Dot can act on them. Every action on a device will wait for your approval
          and be written to the <Link href="/action-log">action log</Link>.
        </p>
      </div>

      <p className="alert alert-warning" role="status">
        Device pairing is not available yet. It needs a pairing service and a small P-Dot app on each device, which are
        not built. Nothing on this page connects to another device; the steps below preview the plan.
      </p>

      <section className="card stack" aria-labelledby="this-device-heading">
        <h2 id="this-device-heading">This device</h2>
        <ThisDevice />
        <p className="hint">
          Read from this browser only. Install the app and allow notifications in <Link href="/settings">Settings</Link>.
        </p>
      </section>

      <section className="card stack" aria-labelledby="pair-heading">
        <div className="panel-heading">
          <h2 id="pair-heading">Pair a laptop or phone</h2>
          <span className="status-pill">Coming soon</span>
        </div>
        <ol className="plain-list">
          {PAIRING_STEPS.map((step) => (
            <li key={step}>{step}</li>
          ))}
        </ol>
        <div className="actions">
          <button type="button" className="button button-primary" disabled aria-describedby="pair-unavailable">
            Create pairing code
          </button>
          <span id="pair-unavailable" className="hint">
            Not available yet.
          </span>
        </div>
      </section>

      <section className="card stack" aria-labelledby="paired-heading">
        <h2 id="paired-heading">Paired devices</h2>
        <p className="muted">No devices can be paired yet, so none are listed.</p>
      </section>
    </main>
  );
}
