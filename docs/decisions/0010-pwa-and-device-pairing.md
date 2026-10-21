# 0010 — Installable app (PWA), push notifications and device pairing

- Status: Partly implemented (2026-10-19). Built: the installable web app for Android and desktop Chrome (manifest, service worker, install prompt, notification permission, offline page) and a Devices page. Proposed, not built: push delivery from the server and device pairing. Each needs the open decisions below before any code.
- Related: [0005 assistant hub](0005-assistant-hub-proposal.md) (the landing page promise "acts on your own laptop and phone"), [0009 memory and actions](0009-memory-documents-actions.md) (approvals and the action log).

## Why

P-Dot should live on the user's phone like an app, remind them when something is due, and later act on their own laptop and phone, with every action approved and logged. The first part needs no new backend. The other two do.

## Built

| Piece | Where | Notes |
| --- | --- | --- |
| Web app manifest | `src/app/manifest.ts`, served at `/manifest.webmanifest` | Standalone display, start page `/today`, icons 192, 512 and maskable 512, shortcuts to Chat and Today. Theme and background are the page ground colour (`#f4f4f7`), so the bar does not flash on load. No orientation lock. |
| Icons | `public/icons/`, `src/app/icon.svg`, `apple-icon.png`, `favicon.ico` | The "P." mark on the indigo-to-violet accent gradient from the design palette. The badge is a white silhouette (Android uses only its shape). |
| Service worker | `public/sw.js` | Caches only the offline page and two icons. Page navigations always go to the network; the cached offline page appears only when the network fails. Workspace pages and API responses hold personal data and are never cached. `public/_headers` sends `Cache-Control: no-cache` for `/sw.js`, so updates reach installed apps. |
| Install prompt | `src/features/pwa/` | An early inline script keeps Chrome's install offer if it fires before React loads. "Install app" appears in the header only while the browser offers it; Settings explains how to install on Android, desktop and iPhone. |
| Notification permission | Settings → App and notifications | Asked only from a button press. A test notification comes from the device's own service worker, not from P-Dot's server, and the page says so. |
| Devices page | `/devices` | What this browser supports (installed, service worker, notifications, push support). Pairing is shown as a preview with a disabled button. |

The proxy (`src/proxy.ts`) skips `/sw.js`, `/manifest.webmanifest` and `/offline.html`, since they need no session.

## Not built: push delivery

The service worker already shows a push message if one arrives (title and body cut to safe lengths, links only to paths on this site). Nothing sends one. To deliver reminders:

- VAPID keys: the public key in a `NEXT_PUBLIC_*` value, the private key as a Worker secret, and an entry in the deploy guard's allow list for the public one only.
- A `push_subscriptions` table with RLS (endpoint, keys, user agent label, created time), plus routes to subscribe and unsubscribe from Settings.
- A sender that runs on Workers. The usual `web-push` package needs Node's crypto; Workers would need the Web Push encryption (RFC 8291) and VAPID signing (RFC 8292) on Web Crypto.
- A scheduler for due reminders, for example a Cloudflare Cron Trigger, with a per-user rate limit.
- What a notification may show on a lock screen. Proposal: the reminder title only, never conversation or memory text.
- iPhone and iPad receive web push only when P-Dot is added to the Home Screen (iOS 16.4 or later).

## Not built: device pairing

The Devices page previews the flow: install P-Dot on the other device, create a one-time code that expires after 10 minutes, enter it there, check the device name and approve it, and remove it at any time. Open decisions:

- What runs on the device. A web app cannot act on a laptop or phone, so this needs a small agent (a desktop helper or a native app) with its own security review.
- Pairing code design: random, single use, stored hashed, a limit on attempts, bound to the account that created it.
- How the server reaches the device (the agent polls, or a WebSocket through a Durable Object) and how a device is revoked.
- Which actions a device may run. Each kind changes something outside P-Dot's own data, so under decision 0009 it needs its own decision, an approval card for every action and an action log entry.

## Verification (2026-10-19)

Checked in the desktop app's built-in browser against the local dev server: the manifest, service worker, offline page and icons are served; the service worker is active with scope `/`; the manifest request no longer runs the proxy; the install button appears for a stand-in `beforeinstallprompt` event, shows the browser dialog once, and hides afterwards; blocked notifications show the right guidance. Not checked: installing on a real Android phone, the real Chrome install dialog, granting notification permission, and the offline page on a real network failure.
