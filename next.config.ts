import type { NextConfig } from "next";

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  // The microphone is allowed for P-Dot's own pages only (chat dictation); no embedded frame can use it.
  // The browser still asks the user before the first use.
  { key: "Permissions-Policy", value: "camera=(), microphone=(self), geolocation=()" },
];

const nextConfig: NextConfig = {
  poweredByHeader: false,
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // Old page addresses still open the page that replaced them.
  async redirects() {
    return [
      { source: "/action-log", destination: "/activity", permanent: true },
      { source: "/workflows", destination: "/today#workflows", permanent: true },
    ];
  },
};

export default nextConfig;
