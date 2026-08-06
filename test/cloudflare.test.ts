import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scanCloudflare } from "../src/cloudflare.js";
import type { IpIndex } from "../src/types.js";

// Fixture store the mocked SDK reads from. vi.hoisted so the vi.mock factory
// (which is hoisted above imports) can reference it.
const fake = vi.hoisted(() => ({
  zones: [] as Array<{ id: string; name: string }>,
  recordsByZone: {} as Record<string, Array<Record<string, unknown>>>,
  ctorOptions: [] as Array<{ apiToken?: string }>,
}));

vi.mock("cloudflare", () => {
  async function* iterate<T>(items: T[]): AsyncGenerator<T> {
    yield* items;
  }
  class FakeCloudflare {
    zones = { list: () => iterate(fake.zones) };
    dns = {
      records: {
        list: ({ zone_id }: { zone_id: string }) =>
          iterate(fake.recordsByZone[zone_id] ?? []),
      },
    };
    constructor(options: { apiToken?: string }) {
      fake.ctorOptions.push(options);
    }
  }
  return { default: FakeCloudflare };
});

/** Seed `count` zones, each holding a single A record, for progress tests. */
function seedZones(count: number): void {
  for (let i = 1; i <= count; i++) {
    const id = `z${i}`;
    fake.zones.push({ id, name: `zone-${i}.example.com` });
    fake.recordsByZone[id] = [
      { type: "A", name: `www.zone-${i}.example.com`, content: `192.0.2.${i}` },
    ];
  }
}

beforeEach(() => {
  fake.zones = [];
  fake.recordsByZone = {};
  fake.ctorOptions = [];
  vi.stubEnv("CLOUDFLARE_API_TOKEN", "fake-cloudflare-token");
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("scanCloudflare", () => {
  it("throws when CLOUDFLARE_API_TOKEN is not set", async () => {
    vi.stubEnv("CLOUDFLARE_API_TOKEN", "");
    const index: IpIndex = new Map();
    await expect(scanCloudflare(index)).rejects.toThrow(
      "CLOUDFLARE_API_TOKEN env var is not set"
    );
  });

  it("passes the token from the environment to the SDK client", async () => {
    await scanCloudflare(new Map());
    expect(fake.ctorOptions).toEqual([{ apiToken: "fake-cloudflare-token" }]);
  });

  it("indexes A and AAAA records and skips other types", async () => {
    fake.zones = [{ id: "z1", name: "example.com" }];
    fake.recordsByZone.z1 = [
      { type: "A", name: "api.example.com", content: "203.0.113.7", proxied: true },
      { type: "AAAA", name: "v6.example.com", content: "2001:DB8::1" },
      { type: "CNAME", name: "www.example.com", content: "api.example.com" },
      { type: "TXT", name: "example.com", content: "v=spf1 -all" },
      { type: "A", name: "empty.example.com" }, // no content — skipped
    ];

    const index: IpIndex = new Map();
    const result = await scanCloudflare(index);

    expect(result).toEqual({ zones: 1, records: 2 });
    expect(index.get("203.0.113.7")?.[0]).toMatchObject({
      source: "cloudflare-dns",
      name: "api.example.com",
      detail: "zone=example.com type=A proxied=true",
    });
    // IPv6 key is normalized to lowercase by addRecord
    expect(index.has("2001:db8::1")).toBe(true);
    expect(index.size).toBe(2);
  });

  it("scans every zone and counts them", async () => {
    fake.zones = [
      { id: "z1", name: "example.com" },
      { id: "z2", name: "example.org" },
    ];
    fake.recordsByZone.z1 = [{ type: "A", name: "a.example.com", content: "192.0.2.1" }];
    fake.recordsByZone.z2 = [{ type: "A", name: "a.example.org", content: "192.0.2.2" }];

    const index: IpIndex = new Map();
    const result = await scanCloudflare(index);

    expect(result).toEqual({ zones: 2, records: 2 });
  });

  it("reports progress every 10 zones with running totals", async () => {
    // 25 zones, one A record each → callbacks at 10 and 20, not at 25.
    seedZones(25);

    const progress: Array<{ zones: number; records: number }> = [];
    const result = await scanCloudflare(new Map(), {
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([
      { zones: 10, records: 10 },
      { zones: 20, records: 20 },
    ]);
    expect(result).toEqual({ zones: 25, records: 25 });
  });

  it("does not report progress before the first 10 zones", async () => {
    seedZones(9);

    const progress: Array<{ zones: number; records: number }> = [];
    await scanCloudflare(new Map(), { onProgress: (p) => progress.push(p) });

    expect(progress).toEqual([]);
  });

  it("scans without a progress callback", async () => {
    seedZones(12);
    await expect(scanCloudflare(new Map())).resolves.toEqual({
      zones: 12,
      records: 12,
    });
  });

  it("counts only zones that survive zoneFilter toward progress", async () => {
    // 30 zones present, but the filter admits exactly one — never reaches 10.
    seedZones(30);

    const progress: Array<{ zones: number; records: number }> = [];
    const result = await scanCloudflare(new Map(), {
      zoneFilter: "zone-3.example.com",
      onProgress: (p) => progress.push(p),
    });

    expect(progress).toEqual([]);
    expect(result).toEqual({ zones: 1, records: 1 });
  });

  it("restricts to a single zone with zoneFilter", async () => {
    fake.zones = [
      { id: "z1", name: "example.com" },
      { id: "z2", name: "example.org" },
    ];
    fake.recordsByZone.z1 = [{ type: "A", name: "a.example.com", content: "192.0.2.1" }];
    fake.recordsByZone.z2 = [{ type: "A", name: "a.example.org", content: "192.0.2.2" }];

    const index: IpIndex = new Map();
    const result = await scanCloudflare(index, { zoneFilter: "example.org" });

    expect(result).toEqual({ zones: 1, records: 1 });
    expect(index.has("192.0.2.1")).toBe(false);
    expect(index.has("192.0.2.2")).toBe(true);
  });
});
