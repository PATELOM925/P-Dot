import { describe, expect, it } from "vitest";
import { WriteFaultError, WriteFaults, describeCase, hasFault, sweepWriteFaults } from "../support/write-faults";

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
    const cases = await sweepWriteFaults(
      async (faults, sweepCase) => {
        const store = faults.wrap(new Store(), ["add"]);
        await store.add("a").catch(() => {});
        await store.add("b").catch(() => {});
        faults.disarm();
        await store.add("retry");
        seen.push(`${sweepCase.map((f) => `${f.fault}:${f.step}`).join(",")}=${store.rows.join("")}`);
      },
      { depth: 1 },
    );
    expect(cases).toHaveLength(4);
    expect(seen).toEqual(["=abretry", "refused:1=bretry", "lost:1=abretry", "refused:2=aretry", "lost:2=abretry"]);
  });

  it("also faults a write that runs only after an earlier write failed", async () => {
    const cases = await sweepWriteFaults(async (faults) => {
      const primary = faults.wrap(new Store(), ["add"], { label: "primary" });
      const recovery = faults.wrap(new Store(), ["add"], { label: "recovery" });
      await primary.add("work").catch(() => recovery.add("undo").catch(() => {}));
      faults.disarm();
    });
    expect(cases.map(describeCase)).toEqual([
      "refused write 1 (primary.add)",
      "lost write 1 (primary.add)",
      "refused write 1 (primary.add) then refused write 2 (recovery.add)",
      "refused write 1 (primary.add) then lost write 2 (recovery.add)",
      "lost write 1 (primary.add) then refused write 2 (recovery.add)",
      "lost write 1 (primary.add) then lost write 2 (recovery.add)",
    ]);
    expect(cases.some((c) => hasFault(c, "lost", "recovery.add"))).toBe(true);
  });

  it("fails with a clear message when the sweep needs too many cases", async () => {
    await expect(
      sweepWriteFaults(
        async (faults) => {
          const store = faults.wrap(new Store(), ["add"]);
          for (const row of ["a", "b", "c"]) await store.add(row).catch(() => {});
        },
        { maxCases: 5 },
      ),
    ).rejects.toThrow("The sweep needs more than 5 cases");
  });

  it("fails a sweep when a replay faults a different write than the plan", async () => {
    let runs = 0;
    await expect(
      sweepWriteFaults(async (faults) => {
        const label = runs === 0 ? "primary" : "unrelated";
        runs += 1;
        const store = faults.wrap(new Store(), ["add"], { label });
        await store.add("x").catch(() => {});
      }),
    ).rejects.toThrow("the faults that fired do not match the plan");
  });

  it("fails a sweep when a planned fault never fires", async () => {
    let first = true;
    await expect(
      sweepWriteFaults(async (faults) => {
        const store = faults.wrap(new Store(), ["add"]);
        if (first) await store.add("only in the dry run");
        first = false;
      }),
    ).rejects.toThrow("a planned fault did not fire");
  });
});
