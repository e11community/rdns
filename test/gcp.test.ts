import { beforeEach, describe, expect, it, vi } from "vitest";
import { scanGcp } from "../src/gcp.js";
import type { IpIndex } from "../src/types.js";

// Fixture store for the mocked @google-cloud/compute clients. Aggregated
// entries mirror the SDK shape: [scopeKey, { instances|addresses|forwardingRules }].
const fake = vi.hoisted(() => ({
  instanceAggregates: [] as Array<[string, { instances?: unknown[] }]>,
  regionalAddressAggregates: [] as Array<[string, { addresses?: unknown[] }]>,
  globalAddresses: [] as unknown[],
  regionalRuleAggregates: [] as Array<[string, { forwardingRules?: unknown[] }]>,
  globalRules: [] as unknown[],
  pagingOptions: [] as unknown[],
  ctorOptions: [] as unknown[],
  closedClients: 0,
}));

vi.mock("@google-cloud/compute", () => {
  async function* iterate<T>(items: T[]): AsyncGenerator<T> {
    yield* items;
  }
  class FakeClient {
    // Subclasses declare no constructor, so ClientOptions land here.
    constructor(options?: unknown) {
      fake.ctorOptions.push(options);
    }
    async close(): Promise<void> {
      fake.closedClients++;
    }
  }
  return {
    InstancesClient: class extends FakeClient {
      aggregatedListAsync(_req: unknown, options?: unknown) {
        fake.pagingOptions.push(options);
        return iterate(fake.instanceAggregates);
      }
    },
    AddressesClient: class extends FakeClient {
      aggregatedListAsync(_req: unknown, options?: unknown) {
        fake.pagingOptions.push(options);
        return iterate(fake.regionalAddressAggregates);
      }
    },
    GlobalAddressesClient: class extends FakeClient {
      listAsync(_req: unknown, options?: unknown) {
        fake.pagingOptions.push(options);
        return iterate(fake.globalAddresses);
      }
    },
    ForwardingRulesClient: class extends FakeClient {
      aggregatedListAsync(_req: unknown, options?: unknown) {
        fake.pagingOptions.push(options);
        return iterate(fake.regionalRuleAggregates);
      }
    },
    GlobalForwardingRulesClient: class extends FakeClient {
      listAsync(_req: unknown, options?: unknown) {
        fake.pagingOptions.push(options);
        return iterate(fake.globalRules);
      }
    },
  };
});

beforeEach(() => {
  fake.instanceAggregates = [];
  fake.regionalAddressAggregates = [];
  fake.globalAddresses = [];
  fake.regionalRuleAggregates = [];
  fake.globalRules = [];
  fake.pagingOptions = [];
  fake.ctorOptions = [];
  fake.closedClients = 0;
});

const PROJECT = "fake-project";

describe("scanGcp", () => {
  it("returns zero counts for an empty project", async () => {
    const index: IpIndex = new Map();
    const counts = await scanGcp(index, { projectId: PROJECT });
    expect(counts).toEqual({ vms: 0, vmIps: 0, addresses: 0, forwardingRules: 0 });
    expect(index.size).toBe(0);
  });

  it("disables autoPaginate on every paging call and closes every client", async () => {
    await scanGcp(new Map(), { projectId: PROJECT });
    // 5 scan functions → 5 paging calls, 5 clients closed
    expect(fake.pagingOptions).toHaveLength(5);
    for (const options of fake.pagingOptions) {
      expect(options).toEqual({ autoPaginate: false });
    }
    expect(fake.closedClients).toBe(5);
  });

  it("requests only the read-only Compute scope on every client", async () => {
    await scanGcp(new Map(), { projectId: PROJECT });

    // All 5 clients, so a new scanner can't silently inherit the SDK default
    // of compute (read-write) + cloud-platform.
    expect(fake.ctorOptions).toHaveLength(5);
    for (const options of fake.ctorOptions) {
      expect(options).toEqual({
        scopes: ["https://www.googleapis.com/auth/compute.readonly"],
      });
    }
  });

  it("indexes VM internal/external IPv4 and IPv6 addresses", async () => {
    fake.instanceAggregates = [
      ["zones/us-central1-a", { instances: [] }], // empty scope skipped
      [
        "zones/us-central1-b",
        {
          instances: [
            {
              name: "web-1",
              status: "RUNNING",
              networkInterfaces: [
                {
                  name: "nic0",
                  networkIP: "10.128.0.5",
                  ipv6Address: "fd20::5",
                  accessConfigs: [{ natIP: "34.10.20.30" }],
                  ipv6AccessConfigs: [{ externalIpv6: "2600:1900::1" }],
                },
              ],
            },
          ],
        },
      ],
    ];

    const index: IpIndex = new Map();
    const counts = await scanGcp(index, { projectId: PROJECT });

    expect(counts.vms).toBe(1);
    expect(counts.vmIps).toBe(4);
    expect(index.get("10.128.0.5")?.[0]).toMatchObject({
      source: "gcp-vm-internal",
      name: "web-1",
      detail: `project=${PROJECT} zone=us-central1-b nic=nic0 status=RUNNING`,
    });
    expect(index.get("34.10.20.30")?.[0]?.source).toBe("gcp-vm-external");
    expect(index.get("fd20::5")?.[0]?.source).toBe("gcp-vm-internal");
    expect(index.get("2600:1900::1")?.[0]?.source).toBe("gcp-vm-external");
  });

  it("indexes regional and global reserved addresses", async () => {
    fake.regionalAddressAggregates = [
      [
        "regions/us-east1",
        {
          addresses: [
            { name: "nat-ip", address: "34.1.1.1", purpose: "NAT_AUTO", status: "IN_USE", users: ["router-1"] },
            { name: "no-ip" }, // no address — skipped
          ],
        },
      ],
    ];
    fake.globalAddresses = [
      { name: "glb-ip", address: "34.2.2.2", purpose: "GLOBAL", status: "RESERVED" },
    ];

    const index: IpIndex = new Map();
    const counts = await scanGcp(index, { projectId: PROJECT });

    expect(counts.addresses).toBe(2);
    expect(index.get("34.1.1.1")?.[0]?.detail).toBe(
      `project=${PROJECT} region=us-east1 purpose=NAT_AUTO status=IN_USE users=1`
    );
    expect(index.get("34.2.2.2")?.[0]?.detail).toContain("scope=global");
  });

  it("indexes forwarding rules and shortens target URLs", async () => {
    fake.regionalRuleAggregates = [
      [
        "regions/us-west1",
        {
          forwardingRules: [
            {
              name: "ilb-fr",
              IPAddress: "10.0.5.5",
              loadBalancingScheme: "INTERNAL",
              ports: ["80", "443"],
              backendService:
                "https://www.googleapis.com/compute/v1/projects/fake-project/regions/us-west1/backendServices/ilb-be",
            },
          ],
        },
      ],
    ];
    fake.globalRules = [
      {
        name: "xlb-fr",
        IPAddress: "34.120.0.1",
        loadBalancingScheme: "EXTERNAL_MANAGED",
        portRange: "443-443",
        target:
          "https://www.googleapis.com/compute/v1/projects/fake-project/global/targetHttpsProxies/xlb-proxy",
      },
    ];

    const index: IpIndex = new Map();
    const counts = await scanGcp(index, { projectId: PROJECT });

    expect(counts.forwardingRules).toBe(2);
    expect(index.get("10.0.5.5")?.[0]?.detail).toBe(
      `project=${PROJECT} region=us-west1 scheme=INTERNAL ports=80,443 target=projects/fake-project/regions/us-west1/backendServices/ilb-be`
    );
    expect(index.get("34.120.0.1")?.[0]?.detail).toBe(
      `project=${PROJECT} scope=global scheme=EXTERNAL_MANAGED ports=443-443 target=projects/fake-project/global/targetHttpsProxies/xlb-proxy`
    );
  });

  it("accumulates records from multiple sources on one IP", async () => {
    fake.globalAddresses = [{ name: "shared-ip", address: "34.9.9.9" }];
    fake.globalRules = [{ name: "shared-fr", IPAddress: "34.9.9.9" }];

    const index: IpIndex = new Map();
    await scanGcp(index, { projectId: PROJECT });

    const hits = index.get("34.9.9.9");
    expect(hits).toHaveLength(2);
    expect(new Set(hits?.map((h) => h.source))).toEqual(
      new Set(["gcp-address", "gcp-forwarding-rule"])
    );
  });
});
