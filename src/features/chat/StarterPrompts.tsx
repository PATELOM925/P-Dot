import type { Mode } from "@/types/api";
import { STARTER_PROMPTS, type StarterPrompt } from "./starter-prompts";

/** Buttons that fill the message box. They never send. */
export function StarterPrompts({ mode, onPick }: { mode: Mode; onPick: (prompt: StarterPrompt) => void }) {
  return (
    <ul className="starter-prompts" aria-label="Example prompts">
      {STARTER_PROMPTS[mode].map((prompt) => (
        <li key={prompt.label}>
          <button type="button" className="starter-prompt" onClick={() => onPick(prompt)}>
            <span className="starter-prompt-label">{prompt.label}</span>
            <span>{prompt.text}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}
