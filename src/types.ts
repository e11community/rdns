// Unified shape: every collected record gets normalised into one of these
// so the lookup logic only has to traverse a single map keyed by IP.

export type Source =
  | "cloudflare-dns"
  | "gcp-vm-internal"
  | "gcp-vm-external"
  | "gcp-address"          // Reserved IPs (regional + global)
  | "gcp-forwarding-rule"; // Load balancer front-end

export interface IpRecord {
  ip: string;              // Always normalised lowercase; IPv4 dotted, IPv6 unbracketed
  source: Source;
  name: string;            // Hostname, VM name, address resource name, etc.
  detail: string;          // Free-form: zone/region/project/LB target/proxied flag
  raw?: unknown;           // Original payload for `--json` and debugging
}

// Map<ip, IpRecord[]> — one IP may legitimately back multiple things
// (e.g. a CF A record AND a GCP forwarding rule).
export type IpIndex = Map<string, IpRecord[]>;

export function addRecord(index: IpIndex, rec: IpRecord): void {
  const key = rec.ip.toLowerCase();
  const existing = index.get(key);
  if (existing) existing.push(rec);
  else index.set(key, [rec]);
}
