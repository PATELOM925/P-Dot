// "What should P-Dot connect to next?" The suggestions the feedback card offers.
// The database accepts any short lowercase kind, so a new suggestion needs no migration.

export const FEEDBACK_KINDS = [
  { id: "slack", label: "Slack" },
  { id: "outlook", label: "Outlook" },
  { id: "spotify", label: "Spotify" },
  { id: "whatsapp", label: "WhatsApp" },
  { id: "apple_calendar", label: "Apple Calendar" },
  { id: "drive", label: "Drive" },
  { id: "other", label: "Other" },
] as const;

export type FeedbackKind = (typeof FEEDBACK_KINDS)[number]["id"];

export const FEEDBACK_KIND_IDS = FEEDBACK_KINDS.map((kind) => kind.id) as [FeedbackKind, ...FeedbackKind[]];
