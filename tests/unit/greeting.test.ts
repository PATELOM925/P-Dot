import { describe, expect, it } from "vitest";
import { nameFromEmail, partOfDay } from "@/lib/greeting";

describe("partOfDay", () => {
  it.each([
    [4, "evening"],
    [5, "morning"],
    [11, "morning"],
    [12, "afternoon"],
    [17, "afternoon"],
    [18, "evening"],
    [23, "evening"],
    [0, "evening"],
  ] as const)("hour %i is %s", (hour, expected) => {
    expect(partOfDay(hour)).toBe(expected);
  });
});

describe("nameFromEmail", () => {
  it("takes the first word before a separator and capitalises it", () => {
    expect(nameFromEmail("sam.rivers@example.com")).toBe("Sam");
    expect(nameFromEmail("ALEX_JONES@example.com")).toBe("Alex");
    expect(nameFromEmail("maria+news@example.com")).toBe("Maria");
  });

  it("returns null when it does not look like a name", () => {
    expect(nameFromEmail(null)).toBeNull();
    expect(nameFromEmail("")).toBeNull();
    expect(nameFromEmail("x@example.com")).toBeNull();
    expect(nameFromEmail("12345@example.com")).toBeNull();
    expect(nameFromEmail("a".repeat(30) + "@example.com")).toBeNull();
  });
});
