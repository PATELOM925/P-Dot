import { describe, expect, it } from "vitest";
import { STICK_PX, createStickController, isNearBottom } from "@/features/chat/useStickToBottom";

describe("isNearBottom", () => {
  const at = (fromBottom: number) => ({ scrollHeight: 2000, clientHeight: 600, scrollTop: 2000 - 600 - fromBottom });

  it("follows at the bottom and up to 79 px above it", () => {
    expect(isNearBottom(at(0))).toBe(true);
    expect(isNearBottom(at(STICK_PX - 1))).toBe(true);
  });

  it("stops following 80 px or more above the bottom", () => {
    expect(isNearBottom(at(STICK_PX))).toBe(false);
    expect(isNearBottom(at(81))).toBe(false);
  });
});

describe("createStickController", () => {
  function setup() {
    const list = { scrollHeight: 2000, clientHeight: 600, scrollTop: 1400 };
    const frames: (() => void)[] = [];
    const awayChanges: boolean[] = [];
    let scrolledToEnd = 0;
    const stick = createStickController({
      metrics: () => list,
      scrollToEnd: () => {
        scrolledToEnd += 1;
        list.scrollTop = list.scrollHeight - list.clientHeight;
      },
      onAwayChange: (away) => awayChanges.push(away),
      schedule: (task) => frames.push(task),
    });
    const flush = () => frames.splice(0).forEach((task) => task());
    return { list, stick, flush, awayChanges, scrolled: () => scrolledToEnd };
  }

  it("shows Jump to latest when the user scrolls up after a finished reply", () => {
    const { list, stick, flush, awayChanges } = setup();
    list.scrollTop = 200;
    stick.onScroll();
    expect(awayChanges).toEqual([]);
    flush();
    expect(awayChanges).toEqual([true]);
  });

  it("updates the visible state at most once for each frame", () => {
    const { list, stick, flush, awayChanges } = setup();
    for (const top of [1000, 800, 600, 400]) {
      list.scrollTop = top;
      stick.onScroll();
    }
    flush();
    expect(awayChanges).toEqual([true]);
  });

  it("does not pull a user down who scrolled up, even before the frame runs", () => {
    const { list, stick, scrolled } = setup();
    list.scrollTop = 200;
    stick.onScroll();
    list.scrollHeight = 2400;
    stick.onContent();
    expect(scrolled()).toBe(0);
    expect(list.scrollTop).toBe(200);
  });

  it("follows new content at the bottom, and Jump goes back to the end and hides the button", () => {
    const { list, stick, flush, awayChanges, scrolled } = setup();
    list.scrollHeight = 2400;
    stick.onContent();
    expect(scrolled()).toBe(1);
    list.scrollTop = 100;
    stick.onScroll();
    flush();
    stick.jump();
    expect(awayChanges).toEqual([true, false]);
    expect(list.scrollTop).toBe(list.scrollHeight - list.clientHeight);
    list.scrollHeight = 2800;
    stick.onContent();
    expect(scrolled()).toBe(3);
  });
});
