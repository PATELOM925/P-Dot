import type { MetadataRoute } from "next";

/** Web app manifest, served at /manifest.webmanifest. Makes P-Dot installable on Android and desktop Chrome. */
export default function manifest(): MetadataRoute.Manifest {
  return {
    id: "/",
    name: "P-Dot",
    short_name: "P-Dot",
    description: "A private assistant that asks before it acts.",
    start_url: "/today",
    scope: "/",
    display: "standalone",
    // The page ground colour (--bg), the same as the theme-color the pages set, so the bar does not flash on load.
    background_color: "#f4f4f7",
    theme_color: "#f4f4f7",
    categories: ["productivity"],
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Chat", url: "/chat", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
      { name: "Today", url: "/today", icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }] },
    ],
  };
}
