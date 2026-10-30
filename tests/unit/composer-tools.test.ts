import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ToolChips, ToolsMenu, type ModeRows, type ToolGroup, type ToolItem } from "@/features/chat/ComposerTools";

// The "+" menu with several sources and the mode rows (decision 0021).

const web: ToolItem = { key: "web", title: "Search the web", description: "d", chip: "Web search", chipClass: "chip-web", icon: "web", on: true, checkbox: true };
const google: ToolItem = { key: "google", title: "Use Google", description: "d", chip: "Google", chipClass: "chip-app", icon: "google", brand: "google", on: true, checkbox: true };
const notion: ToolItem = { key: "app:notion", title: "Use Notion", description: "d", chip: "Notion", chipClass: "chip-app", icon: "app", brand: "notion", on: true, checkbox: true };
const linear: ToolItem = { key: "app:linear", title: "Use Linear", description: "d", chip: "Linear", chipClass: "chip-app", icon: "app", brand: "linear", on: false, checkbox: true };
const think: ToolItem = { key: "deep", title: "Think harder", description: "d", chip: "Think harder", chipClass: "chip-deep", icon: "deep", on: false };
const groups: ToolGroup[] = [
  { label: "Sources", items: [web, google, notion, linear] },
  { label: "How to answer", items: [think] },
];
const noop = () => undefined;

function menu(mode?: ModeRows) {
  return renderToStaticMarkup(
    createElement(ToolsMenu, { open: true, onOpenChange: noop, groups, onToggle: noop, disabled: false, ...(mode ? { mode } : {}) }),
  );
}

const rows = (html: string) => [...html.matchAll(/<button[^>]*role="menuitem(?:checkbox|radio)"[^>]*>[\s\S]*?<\/button>/g)].map((m) => m[0]);

describe("ToolsMenu", () => {
  it("shows each source as a checkbox with its state, and the other rows as switches", () => {
    const html = menu();
    const all = rows(html);
    expect(all).toHaveLength(5);
    for (const row of all.slice(0, 4)) expect(row).toContain('class="tool-check"');
    expect(all[4]).toContain('class="tool-switch"');
    expect(all.map((row) => /aria-checked="(true|false)"/.exec(row)![1])).toEqual(["true", "true", "true", "false", "false"]);
  });

  it("shows the brand mark of Google and each app", () => {
    const html = menu();
    const all = rows(html);
    for (const row of all.slice(1, 4)) expect(row).toMatch(/<svg[^>]*class="brand-mark/);
  });

  it("puts the sources and the answer options in labelled groups", () => {
    const html = menu();
    expect(html).toContain('role="group" aria-label="Sources"');
    expect(html).toContain('role="group" aria-label="How to answer"');
  });

  it("has no mode rows unless asked", () => {
    expect(menu()).not.toContain("menuitemradio");
  });

  it("says that a new chat takes the mode", () => {
    const html = menu({ current: "personal", inConversation: false, pending: false, onSelect: noop });
    const radios = rows(html).filter((row) => row.includes("menuitemradio"));
    expect(radios).toHaveLength(2);
    expect(radios[0]).toContain('aria-checked="true"');
    expect(radios[0]).toContain("Personal mode");
    expect(radios[0]).toContain("For this new chat.");
    expect(radios[1]).toContain('aria-checked="false"');
    expect(radios[1]).toContain("Use Work for this new chat.");
  });

  it("says that an open conversation keeps its mode and the other mode starts a new chat", () => {
    const html = menu({ current: "work", inConversation: true, pending: true, onSelect: noop });
    const radios = rows(html).filter((row) => row.includes("menuitemradio"));
    expect(radios[0]).toContain("Starts a new chat. This chat stays Work.");
    expect(radios[1]).toContain("This chat is in Work.");
    for (const row of radios) expect(row).toContain('aria-disabled="true"');
  });
});

describe("ToolChips", () => {
  it("shows one chip for every source that is on, with its brand mark", () => {
    const html = renderToStaticMarkup(createElement(ToolChips, { items: [web, google, notion, linear, think], onToggle: noop, disabled: false, inputRef: { current: null } }));
    const chips = [...html.matchAll(/aria-label="([^"]+) is on\. Turn off"/g)].map((m) => m[1]);
    expect(chips).toEqual(["Web search", "Google", "Notion"]);
    expect(html.match(/class="brand-mark"/g)).toHaveLength(2);
  });
});
