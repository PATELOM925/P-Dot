import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Every page and API route is rendered per request (they read the session
// cookie), so no incremental cache (R2/KV) is configured.
export default defineCloudflareConfig();
