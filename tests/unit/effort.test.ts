import { describe, expect, it } from "vitest";
import { effortAfterAccept } from "@/features/chat/effort";

describe("effortAfterAccept", () => {
  it("resets Think harder to Auto when the switch was not touched", () => {
    expect(effortAfterAccept({ effort: "deep", version: 3 }, { effort: "deep", version: 3 })).toBe("auto");
  });

  it("keeps Auto when the message was sent with Auto", () => {
    expect(effortAfterAccept({ effort: "auto", version: 3 }, { effort: "auto", version: 3 })).toBe("auto");
  });

  it("keeps a newer Think harder choice made before the old message was accepted", () => {
    // Sent with deep, then the user chose Auto and Think harder again for the next message.
    expect(effortAfterAccept({ effort: "deep", version: 3 }, { effort: "deep", version: 5 })).toBe("deep");
  });

  it("keeps a newer Auto choice made before the old message was accepted", () => {
    expect(effortAfterAccept({ effort: "deep", version: 3 }, { effort: "auto", version: 4 })).toBe("auto");
  });

  it("does not change a choice made after an Auto message was sent", () => {
    expect(effortAfterAccept({ effort: "auto", version: 3 }, { effort: "deep", version: 4 })).toBe("deep");
  });
});
