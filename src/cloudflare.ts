import Cloudflare from "cloudflare";
import { addRecord, type IpIndex } from "./types.js";

// Only A and AAAA carry IP addresses we care about for an rDNS-style lookup.
// (CNAMEs are followed implicitly when their target itself has an A/AAAA in the index.)
const IP_RECORD_TYPES = new Set(["A", "AAAA"]);

// Each zone costs a separate record-listing round trip, so a large account
// spends minutes here with nothing to show. Report every this many zones.
const PROGRESS_INTERVAL = 10;

export interface CloudflareScanCounts {
  zones: number;
  records: number;
}

export interface CloudflareScanOptions {
  /** Optional: restrict to a single zone for faster runs */
  zoneFilter?: string;
  /** Called with running totals after every {@link PROGRESS_INTERVAL} zones. */
  onProgress?: (counts: CloudflareScanCounts) => void;
}

export async function scanCloudflare(
  index: IpIndex,
  opts: CloudflareScanOptions = {}
): Promise<CloudflareScanCounts> {
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  if (!apiToken) {
    throw new Error("CLOUDFLARE_API_TOKEN env var is not set");
  }

  const cf = new Cloudflare({ apiToken });

  let zoneCount = 0;
  let recordCount = 0;

  // SDK iterator auto-paginates: confirmed in Cloudflare Node SDK docs.
  for await (const zone of cf.zones.list()) {
    if (opts.zoneFilter && zone.name !== opts.zoneFilter) continue;
    zoneCount++;

    for await (const record of cf.dns.records.list({ zone_id: zone.id })) {
      if (!record.type || !IP_RECORD_TYPES.has(record.type)) continue;
      // `content` holds the IP string for A/AAAA records.
      const content = (record as { content?: string }).content;
      if (!content) continue;

      addRecord(index, {
        ip: content,
        source: "cloudflare-dns",
        name: record.name ?? "(unnamed)",
        detail: `zone=${zone.name} type=${record.type} proxied=${
          (record as { proxied?: boolean }).proxied ?? false
        }`,
        raw: record,
      });
      recordCount++;
    }

    if (zoneCount % PROGRESS_INTERVAL === 0) {
      opts.onProgress?.({ zones: zoneCount, records: recordCount });
    }
  }

  return { zones: zoneCount, records: recordCount };
}
