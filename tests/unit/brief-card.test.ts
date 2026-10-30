import { describe, expect, it } from "vitest";
import { briefRequest, briefTopicsKey, localBriefDate, parseTopics, topicsFromMemories } from "@/features/today/brief";
import { chatRequestSchema } from "@/lib/schemas";

describe("morning brief helpers", () => {
  it("takes up to 3 unique, trimmed topics", () => {
    expect(parseTopics(" cricket , AI chips;; Cricket\n local news, extra ")).toEqual(["cricket", "AI chips", "local news"]);
    expect(parseTopics(" , ; ")).toEqual([]);
    expect(parseTopics("x".repeat(90))[0]).toHaveLength(60);
  });

  it("makes topics from at most 3 memories", () => {
    expect(topicsFromMemories(["  Follows   F1 ", "", "Works on Rust", "Likes jazz", "Fourth"])).toBe("Follows F1, Works on Rust, Likes jazz");
  });

  it("writes the local date in fixed words", () => {
    expect(localBriefDate(new Date(2026, 9, 30, 8, 0))).toBe("Fri 30 Oct 2026");
  });

  it("builds a request that the server schema accepts, with no other source", () => {
    const request = briefRequest("work", ["AI chips", "markets"], localBriefDate(new Date(2026, 0, 2)));
    expect(chatRequestSchema.safeParse(request).success).toBe(true);
    expect(request).toMatchObject({ webSearch: false, mode: "work", brief: { topics: ["AI chips", "markets"], date: "Fri 2 Jan 2026" } });
    expect(briefTopicsKey("work")).not.toBe(briefTopicsKey("personal"));
  });
});
