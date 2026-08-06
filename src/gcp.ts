import {
  InstancesClient,
  AddressesClient,
  GlobalAddressesClient,
  ForwardingRulesClient,
  GlobalForwardingRulesClient,
} from "@google-cloud/compute";
import { addRecord, type IpIndex } from "./types.js";

// gax forces autoPaginate off in *Async paging methods and emits
// AutopaginateTrueWarning if the default (true) reaches them — pass it
// explicitly to keep the output clean. Iteration still fetches every page.
const PAGING_OPTIONS = { autoPaginate: false } as const;

// Every Compute call in this file is a list; nothing here mutates. The
// generated clients otherwise request compute (read-write) + cloud-platform
// (every Google Cloud API), so asking for the read-only scope is the narrowest
// grant that still satisfies all five scanners.
//
// This binds credential types whose scopes are chosen at token-request time:
// service account keys, workload identity, and GCE/Cloud Run metadata tokens.
// User credentials from `gcloud auth application-default login` carry their
// scopes inside the refresh token, so local ADC is bounded by that login
// instead — this is a no-op there, not a downgrade.
const CLIENT_OPTIONS = {
  scopes: ["https://www.googleapis.com/auth/compute.readonly"],
};

export interface GcpScanOptions {
  projectId: string;
}

export interface GcpScanCounts {
  vms: number;
  vmIps: number;
  addresses: number;
  forwardingRules: number;
}

/**
 * Scan a single GCP project. Auth comes from Application Default Credentials
 * (gcloud auth application-default login, GOOGLE_APPLICATION_CREDENTIALS, or
 * the workload's attached service account).
 */
export async function scanGcp(
  index: IpIndex,
  opts: GcpScanOptions
): Promise<GcpScanCounts> {
  const project = opts.projectId;
  const counts: GcpScanCounts = {
    vms: 0,
    vmIps: 0,
    addresses: 0,
    forwardingRules: 0,
  };

  await Promise.all([
    scanInstances(project, index, counts),
    scanRegionalAddresses(project, index, counts),
    scanGlobalAddresses(project, index, counts),
    scanRegionalForwardingRules(project, index, counts),
    scanGlobalForwardingRules(project, index, counts),
  ]);

  return counts;
}

// --- VMs --------------------------------------------------------------------

async function scanInstances(
  project: string,
  index: IpIndex,
  counts: GcpScanCounts
): Promise<void> {
  const client = new InstancesClient(CLIENT_OPTIONS);
  try {
    // aggregatedListAsync yields [zoneKey, { instances?: Instance[], warning?: ... }]
    for await (const [zoneKey, scoped] of client.aggregatedListAsync(
      { project },
      PAGING_OPTIONS
    )) {
      const instances = scoped?.instances ?? [];
      if (instances.length === 0) continue;

      // zoneKey looks like "zones/us-central1-a"
      const zone = zoneKey.replace(/^zones\//, "");

      for (const inst of instances) {
        counts.vms++;
        const name = inst.name ?? "(unnamed)";

        for (const nic of inst.networkInterfaces ?? []) {
          // Internal IPv4
          if (nic.networkIP) {
            addRecord(index, {
              ip: nic.networkIP,
              source: "gcp-vm-internal",
              name,
              detail: `project=${project} zone=${zone} nic=${nic.name ?? "?"} status=${inst.status ?? "?"}`,
              raw: inst,
            });
            counts.vmIps++;
          }

          // Internal IPv6 (if dual-stack)
          if (nic.ipv6Address) {
            addRecord(index, {
              ip: nic.ipv6Address,
              source: "gcp-vm-internal",
              name,
              detail: `project=${project} zone=${zone} nic=${nic.name ?? "?"} ipv6 status=${inst.status ?? "?"}`,
              raw: inst,
            });
            counts.vmIps++;
          }

          // External IPv4 access configs
          for (const ac of nic.accessConfigs ?? []) {
            if (ac.natIP) {
              addRecord(index, {
                ip: ac.natIP,
                source: "gcp-vm-external",
                name,
                detail: `project=${project} zone=${zone} nic=${nic.name ?? "?"} status=${inst.status ?? "?"}`,
                raw: inst,
              });
              counts.vmIps++;
            }
          }

          // External IPv6 access configs
          for (const ac of nic.ipv6AccessConfigs ?? []) {
            if (ac.externalIpv6) {
              addRecord(index, {
                ip: ac.externalIpv6,
                source: "gcp-vm-external",
                name,
                detail: `project=${project} zone=${zone} nic=${nic.name ?? "?"} ipv6 status=${inst.status ?? "?"}`,
                raw: inst,
              });
              counts.vmIps++;
            }
          }
        }
      }
    }
  } finally {
    await client.close();
  }
}

// --- Reserved IPs -----------------------------------------------------------

async function scanRegionalAddresses(
  project: string,
  index: IpIndex,
  counts: GcpScanCounts
): Promise<void> {
  const client = new AddressesClient(CLIENT_OPTIONS);
  try {
    for await (const [regionKey, scoped] of client.aggregatedListAsync(
      { project },
      PAGING_OPTIONS
    )) {
      const addresses = scoped?.addresses ?? [];
      if (addresses.length === 0) continue;
      const region = regionKey.replace(/^regions\//, "");

      for (const addr of addresses) {
        if (!addr.address) continue;
        addRecord(index, {
          ip: addr.address,
          source: "gcp-address",
          name: addr.name ?? "(unnamed)",
          detail: `project=${project} region=${region} purpose=${addr.purpose ?? "?"} status=${addr.status ?? "?"} users=${(addr.users ?? []).length}`,
          raw: addr,
        });
        counts.addresses++;
      }
    }
  } finally {
    await client.close();
  }
}

async function scanGlobalAddresses(
  project: string,
  index: IpIndex,
  counts: GcpScanCounts
): Promise<void> {
  const client = new GlobalAddressesClient(CLIENT_OPTIONS);
  try {
    for await (const addr of client.listAsync({ project }, PAGING_OPTIONS)) {
      if (!addr.address) continue;
      addRecord(index, {
        ip: addr.address,
        source: "gcp-address",
        name: addr.name ?? "(unnamed)",
        detail: `project=${project} scope=global purpose=${addr.purpose ?? "?"} status=${addr.status ?? "?"} users=${(addr.users ?? []).length}`,
        raw: addr,
      });
      counts.addresses++;
    }
  } finally {
    await client.close();
  }
}

// --- Load balancer front-ends (forwarding rules) ----------------------------

async function scanRegionalForwardingRules(
  project: string,
  index: IpIndex,
  counts: GcpScanCounts
): Promise<void> {
  const client = new ForwardingRulesClient(CLIENT_OPTIONS);
  try {
    for await (const [regionKey, scoped] of client.aggregatedListAsync(
      { project },
      PAGING_OPTIONS
    )) {
      const rules = scoped?.forwardingRules ?? [];
      if (rules.length === 0) continue;
      const region = regionKey.replace(/^regions\//, "");

      for (const rule of rules) {
        if (!rule.IPAddress) continue;
        addRecord(index, {
          ip: rule.IPAddress,
          source: "gcp-forwarding-rule",
          name: rule.name ?? "(unnamed)",
          detail: `project=${project} region=${region} scheme=${rule.loadBalancingScheme ?? "?"} ports=${rule.portRange ?? rule.ports?.join(",") ?? "?"} target=${shortTarget(rule.target ?? rule.backendService)}`,
          raw: rule,
        });
        counts.forwardingRules++;
      }
    }
  } finally {
    await client.close();
  }
}

async function scanGlobalForwardingRules(
  project: string,
  index: IpIndex,
  counts: GcpScanCounts
): Promise<void> {
  const client = new GlobalForwardingRulesClient(CLIENT_OPTIONS);
  try {
    for await (const rule of client.listAsync({ project }, PAGING_OPTIONS)) {
      if (!rule.IPAddress) continue;
      addRecord(index, {
        ip: rule.IPAddress,
        source: "gcp-forwarding-rule",
        name: rule.name ?? "(unnamed)",
        detail: `project=${project} scope=global scheme=${rule.loadBalancingScheme ?? "?"} ports=${rule.portRange ?? rule.ports?.join(",") ?? "?"} target=${shortTarget(rule.target ?? rule.backendService)}`,
        raw: rule,
      });
      counts.forwardingRules++;
    }
  } finally {
    await client.close();
  }
}

function shortTarget(t: string | null | undefined): string {
  if (!t) return "?";
  // Strip the long https://www.googleapis.com/compute/v1/projects/... prefix
  const idx = t.indexOf("/projects/");
  return idx >= 0 ? t.slice(idx + 1) : t;
}
