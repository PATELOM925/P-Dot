import { afterEach, describe, expect, it } from "vitest";
import { beginChatModeSwitch, chatStart, dropCarriedDraft, endChatModeSwitch } from "@/features/mode/switch-state";

afterEach(() => endChatModeSwitch());

describe("chatStart after a mode switch on /chat", () => {
  it("starts the new mode's chat with no conversation, even with the old mode's ?c= still in the address", () => {
    beginChatModeSwitch("work", "draft for work");
    expect(chatStart("work", "personal-conversation", "")).toEqual({ conversationId: null, draft: "draft for work" });
  });

  it("starts with no conversation after a header switch, which carries no draft", () => {
    beginChatModeSwitch("work");
    expect(chatStart("work", "personal-conversation", "")).toEqual({ conversationId: null, draft: "" });
  });

  it("does not carry a draft of only spaces", () => {
    beginChatModeSwitch("personal", "   ");
    expect(chatStart("personal", null, "")).toEqual({ conversationId: null, draft: "" });
  });

  it("does not show the draft again when the old chat sent it while the switch was pending", () => {
    beginChatModeSwitch("work", "sent already");
    dropCarriedDraft();
    expect(chatStart("work", "personal-conversation", "")).toEqual({ conversationId: null, draft: "" });
  });

  it("does not touch a chat of the other mode, so the old chat keeps its conversation until it unmounts", () => {
    beginChatModeSwitch("work", "draft for work");
    expect(chatStart("personal", "personal-conversation", "")).toEqual({
      conversationId: "personal-conversation",
      draft: "",
    });
  });

  it("opens ?c= normally when the new chat already took the switch", () => {
    beginChatModeSwitch("work", "draft for work");
    endChatModeSwitch();
    expect(chatStart("work", "work-conversation", "")).toEqual({ conversationId: "work-conversation", draft: "" });
  });

  it("opens ?c= and keeps ?ask= when there was no switch", () => {
    expect(chatStart("personal", "personal-conversation", "from Today")).toEqual({
      conversationId: "personal-conversation",
      draft: "from Today",
    });
  });

  it("dropping the draft with no switch pending does nothing", () => {
    dropCarriedDraft();
    expect(chatStart("work", "work-conversation", "")).toEqual({ conversationId: "work-conversation", draft: "" });
  });
});
