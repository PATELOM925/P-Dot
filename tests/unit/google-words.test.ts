import { describe, expect, it } from "vitest";
import { googleWords } from "@/lib/google-words";

describe("googleWords", () => {
  it.each([
    ["Check my latest emails", { mail: true, calendar: false }],
    ["Search my Gmail", { mail: true, calendar: false }],
    ["What is in my inbox?", { mail: true, calendar: false }],
    ["Any mail for me today?", { mail: true, calendar: false }],
    ["Is there mail from the bank?", { mail: true, calendar: false }],
    ["Did I get any mail today?", { mail: true, calendar: false }],
    ["What meetings do I have this week?", { mail: false, calendar: true }],
    ["Do I have any meetings tomorrow?", { mail: false, calendar: true }],
    ["Am I free on Friday?", { mail: false, calendar: true }],
    ["Show my agenda for Monday", { mail: false, calendar: true }],
    ["When is my dentist appointment?", { mail: false, calendar: true }],
    ["I'm late, when is the meeting?", { mail: false, calendar: true }],
    ["Is the meeting with me at 3?", { mail: false, calendar: true }],
  ])("finds the user's own mail or calendar in %j", (message, expected) => {
    expect(googleWords(message)).toMatchObject({ ...expected, read: true });
  });

  it.each([
    "Any news about the Fed meeting today?",
    "mail merge in Word",
    "How do I do a mail merge in Word?",
    "Translate 'appointment'",
    "What is on the agenda of the G20 summit?",
    "How do I prepare for a job interview meeting?",
    "Tips for a short team meeting",
  ])("does not treat %j as the user's mail or calendar", (message) => {
    expect(googleWords(message)).toMatchObject({ mail: false, calendar: false, read: false });
  });
});

describe("strong Google words (decision 0021)", () => {
  it.each([
    ["Check my email", true],
    ["What is in my inbox?", true],
    ["What is on my calendar?", true],
    ["What's my schedule today?", true],
    ["Am I free on Friday?", true],
    ["Schedule a meeting with Sam", true],
    ["Find my meeting notes", false],
    ["When is my dentist appointment?", false],
    ["Show my agenda for Monday", false],
    ["Any mail for me?", true],
    ["Did I get mail?", false],
  ])("%j is strong: %s", (message, strong) => {
    expect(googleWords(message).strong).toBe(strong);
  });
});
