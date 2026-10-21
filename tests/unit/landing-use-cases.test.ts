import { describe, expect, it } from "vitest";
import { USE_CASES } from "@/features/landing/DynamicAgentCard";

describe("landing page dynamic use cases", () => {
  it("provides multiple diverse use cases demonstrating personal bot usage", () => {
    expect(USE_CASES.length).toBeGreaterThanOrEqual(4);
  });

  it("includes the foundational haircut/errands scenario preserving initial design", () => {
    const haircutCase = USE_CASES.find((c) => c.id === "errands");
    expect(haircutCase).toBeDefined();
    expect(haircutCase?.task).toBe("Get me ready for Friday and book a haircut");
    expect(haircutCase?.steps).toHaveLength(5);

    const toolsUsed = haircutCase?.steps.map((s) => s.tool).filter(Boolean);
    expect(toolsUsed).toContain("Calendar");
    expect(toolsUsed).toContain("Gmail");
    expect(toolsUsed).toContain("Telegram");
  });

  it("ensures every use case has valid required metadata, unique IDs, and an approval step", () => {
    const ids = new Set<string>();

    for (const useCase of USE_CASES) {
      expect(ids.has(useCase.id)).toBe(false);
      ids.add(useCase.id);

      expect(useCase.tabLabel).toBeTruthy();
      expect(useCase.icon).toBeTruthy();
      expect(useCase.category).toBeTruthy();
      expect(useCase.task).toBeTruthy();
      expect(useCase.badgeWaiting).toBeTruthy();
      expect(useCase.badgeApproved).toBeTruthy();
      expect(useCase.badgeSkipped).toBeTruthy();
      expect(useCase.steps.length).toBeGreaterThanOrEqual(4);

      // Verify human-in-the-loop approval step exists
      const approvalStep = useCase.steps.find((s) => s.state === "approval");
      expect(approvalStep).toBeDefined();
      expect(approvalStep?.approvalPrompt).toBeTruthy();
      expect(approvalStep?.approvedDetail).toBeTruthy();
      expect(approvalStep?.skippedDetail).toBeTruthy();
    }
  });

  it("covers key tool integrations across scenarios", () => {
    const allTools = new Set(
      USE_CASES.flatMap((c) => c.steps.map((s) => s.tool).filter(Boolean))
    );

    expect(allTools.has("Calendar")).toBe(true);
    expect(allTools.has("Gmail")).toBe(true);
    expect(allTools.has("GitHub")).toBe(true);
    expect(allTools.has("Telegram")).toBe(true);
    expect(allTools.has("Search")).toBe(true);
  });
});
