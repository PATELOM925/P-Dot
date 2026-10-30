// Which connector cards the Connectors page shows where (decisions 0016 and
// 0020). Pure, so it is unit-tested. A config-gated connector without its
// settings stays under "Coming soon", so the page with no new settings looks
// as it did before.
import type { BrandId } from "@/components/ui/brand-marks";
import { MCP_CONFIG_GATED, MCP_SERVER_IDS, type McpServerId } from "@/lib/connectors";

export interface PlannedConnector {
  key: string;
  name: string;
  can: string;
  asks: string;
  brand?: BrandId;
}

export const PLANNED: readonly PlannedConnector[] = [
  { key: "telegram", brand: "telegram", name: "Telegram", can: "deliver your daily brief and to-do list to your own chat", asks: "before messaging anyone else" },
  { key: "github", brand: "github", name: "GitHub", can: "read pull requests and issues you can see", asks: "before commenting, merging or changing anything" },
  { key: "vercel", brand: "vercel", name: "Vercel", can: "report deploy status and errors", asks: "before deploying or changing settings" },
  { key: "whatsapp", brand: "whatsapp", name: "WhatsApp", can: "send you briefs and reminders", asks: "before every message to another person" },
  { key: "phone", name: "Phone calls", can: "call to book appointments for you", asks: "before every call, with the number and purpose shown" },
];

export interface ConnectorLayout {
  /** The MCP apps with a card under "Your accounts". */
  apps: McpServerId[];
  /** True when the Telegram card is under "Your accounts". */
  telegram: boolean;
  /** The cards under "Coming soon". */
  planned: PlannedConnector[];
}

export function connectorLayout(input: { isAppReady: (app: McpServerId) => boolean; telegramReady: boolean }): ConnectorLayout {
  const apps = MCP_SERVER_IDS.filter((app) => !MCP_CONFIG_GATED.includes(app) || input.isAppReady(app));
  const live = new Set<string>([...apps, ...(input.telegramReady ? ["telegram"] : [])]);
  return { apps, telegram: input.telegramReady, planned: PLANNED.filter((item) => !live.has(item.key)) };
}
