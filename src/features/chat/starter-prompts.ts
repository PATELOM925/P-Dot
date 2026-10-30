import type { Effort, Mode } from "@/types/api";

export interface StarterPrompt {
  label: string;
  text: string;
  webSearch: boolean;
  effort: Effort;
}

// Example prompts for an empty chat. The memory and reminder prompts make a card when the
// assistant has those tools, and a text reply when it does not.
export const STARTER_PROMPTS: Record<Mode, StarterPrompt[]> = {
  personal: [
    {
      label: "Search the web",
      text: "What are the top news stories today? Give me the sources.",
      webSearch: true,
      effort: "auto",
    },
    { label: "Remember a preference", text: "Remember that I prefer short answers.", webSearch: false, effort: "auto" },
    {
      label: "Make a reminder",
      text: "Remind me to call the dentist tomorrow at 10 am.",
      webSearch: false,
      effort: "auto",
    },
    {
      label: "Think harder",
      text: "Plan a 3-day weekend in Lisbon on a small budget.",
      webSearch: false,
      effort: "deep",
    },
  ],
  work: [
    {
      label: "Search the web",
      text: "What is new in the latest Next.js release? Give me the sources.",
      webSearch: true,
      effort: "auto",
    },
    { label: "Remember a preference", text: "Remember that I prefer short answers.", webSearch: false, effort: "auto" },
    {
      label: "Make a reminder",
      text: "Remind me to send the weekly report on Friday at 4 pm.",
      webSearch: false,
      effort: "auto",
    },
    {
      label: "Think harder",
      text: "Plan my week to ship a small feature by Friday.",
      webSearch: false,
      effort: "deep",
    },
  ],
};
