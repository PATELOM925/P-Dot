import { QrCode } from "@/components/ui/QrCode";
import { InstallControl } from "@/features/pwa/AppSettings";

/**
 * "Open on your phone" (decision 0020). The QR code holds the site address
 * only, never a sign-in link: a link that signs in another device needs a
 * key that P-Dot does not keep. Data is on the server, so the phone shows the
 * same account after its own sign-in.
 */
export function OpenOnPhoneCard({ siteUrl }: { siteUrl: string }) {
  const target = `${siteUrl}/today`;
  return (
    <article className="panel" id="phone" aria-labelledby="phone-heading">
      <div className="panel-heading">
        <h3 id="phone-heading">
          <span className="chip">Open on your phone</span>
        </h3>
        <span className="status-pill status-executed">Ready</span>
      </div>
      <div className="qr-row">
        <QrCode text={target} label={`QR code for ${target}`} />
        <div className="stack">
          <p>Scan this code with your phone camera. Sign in on the phone with the same account.</p>
          <p className="muted">
            Your chats, tasks and memories are on the server, so your laptop, desktop and phone show the same data. The
            code holds only the site address, not a sign-in.
          </p>
        </div>
      </div>
      <InstallControl />
    </article>
  );
}
