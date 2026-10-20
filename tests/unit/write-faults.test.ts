import { describe, expect, it } from "vitest";
import { WriteFaultError, WriteFaults, sweepWriteFaults } from "../support/write-faults";

class Store {
  rows: string[] = [];
  async add(row: string) {
    this.rows.push(row);
    return this.rows.length;
  }
  async read() {
    return [...this.rows];
  }
}

describe("WriteFaults", () => {
  it("counts writes across fakes in call order", async () => {
    const faults = new WriteFaults();
    const a = faults.wrap(new Store(), ["add"], { label: "a" });
    const b = faults.wrap(new Store(), ["add"], { label: "b", detail: (_m, args) => String(args[0]) });
    await a.add("x");
    await b.add("y");
    await a.read();
    expect(faults.calls).toEqual(["a.add", "b.add:y"]);
  });

  it("a refused write changes nothing and throws", async () => {
    const faults = new WriteFaults().fail("refused", 1);
    const store = faults.wrap(new Store(), ["add"]);
    await expect(store.add("x")).rejects.toBeInstanceOf(WriteFaultError);
    expect(store.rows).toEqual([]);
    expect(faults.fired).toEqual([{ step: 1, fault: "refused", label: "Store.add" }]);
  });

  it("a lost write commits and then throws", async () => {
    const faults = new WriteFaults().fail("lost", 2);
    const store = faults.wrap(new Store(), ["add"]);
    await store.add("x");
    await expect(store.add("y")).rejects.toThrow("simulated lost write at step 2");
    expect(store.rows).toEqual(["x", "y"]);
  });

  it("can return a failure value instead of throwing", async () => {
    const faults = new WriteFaults().fail("refused", 1);
    const store = faults.wrap(new Store(), ["add"], { failWith: () => -1 });
    expect(await store.add("x")).toBe(-1);
  });

  it("stops counting and failing after disarm", async () => {
    const faults = new WriteFaults().fail("refused", 2);
    const store = faults.wrap(new Store(), ["add"]);
    await store.add("x");
    faults.disarm();
    await store.add("y");
    expect(faults.calls).toEqual(["Store.add"]);
    expect(store.rows).toEqual(["x", "y"]);
  });

  it("sweeps every counted write with both faults", async () => {
    const seen: string[] = [];
    const cases = await sweepWriteFaults(async (faults, sweepCase) => {
      const store = faults.wrap(new Store(), ["add"]);
      await store.add("a").catch(() => {});
      await store.add("b").catch(() => {});
      faults.disarm();
      await store.add("retry");
      seen.push(sweepCase ? `${sweepCase.fault}:${sweepCase.step}:${store.rows.join("")}` : store.rows.join(""));
    });
    expect(cases).toHaveLength(4);
    expect(seen).toEqual(["abretry", "refused:1:bretry", "lost:1:abretry", "refused:2:aretry", "lost:2:abretry"]);
  });

  it("fails a sweep when a planned fault never fires", async () => {
    let first = true;
    await expect(
      sweepWriteFaults(async (faults) => {
        const store = faults.wrap(new Store(), ["add"]);
        if (first) await store.add("only in the dry run");
        first = false;
      }),
    ).rejects.toThrow("the planned fault did not fire");
  });
});
