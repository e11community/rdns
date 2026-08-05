import { describe, expect, it } from "vitest";
import { addRecord, type IpIndex, type IpRecord } from "../src/types.js";

function rec(overrides: Partial<IpRecord> = {}): IpRecord {
  return {
    ip: "10.0.0.1",
    source: "gcp-vm-internal",
    name: "vm-1",
    detail: "project=p zone=z",
    ...overrides,
  };
}

describe("addRecord", () => {
  it("creates a new entry for an unseen IP", () => {
    const index: IpIndex = new Map();
    addRecord(index, rec());
    expect(index.size).toBe(1);
    expect(index.get("10.0.0.1")).toHaveLength(1);
  });

  it("appends to an existing entry for the same IP", () => {
    const index: IpIndex = new Map();
    addRecord(index, rec({ name: "vm-1" }));
    addRecord(index, rec({ name: "lb-1", source: "gcp-forwarding-rule" }));
    const hits = index.get("10.0.0.1");
    expect(hits).toHaveLength(1 + 1);
    expect(hits?.map((r) => r.name)).toEqual(["vm-1", "lb-1"]);
  });

  it("normalizes the key to lowercase (IPv6)", () => {
    const index: IpIndex = new Map();
    addRecord(index, rec({ ip: "2600:1901:0:ABCD::" }));
    expect(index.has("2600:1901:0:abcd::")).toBe(true);
    expect(index.has("2600:1901:0:ABCD::")).toBe(false);
    // The stored record keeps its original casing; only the key is normalized.
    expect(index.get("2600:1901:0:abcd::")?.[0]?.ip).toBe("2600:1901:0:ABCD::");
  });

  it("keeps records for different IPs separate", () => {
    const index: IpIndex = new Map();
    addRecord(index, rec({ ip: "10.0.0.1" }));
    addRecord(index, rec({ ip: "10.0.0.2" }));
    expect(index.size).toBe(2);
  });
});
