// Library entry point. The CLI (cli.ts) is the primary consumer, but the
// scanners and index types are usable programmatically via this barrel.
export { scanCloudflare, type CloudflareScanOptions } from "./cloudflare.js";
export { scanGcp, type GcpScanOptions, type GcpScanCounts } from "./gcp.js";
export { addRecord, type IpIndex, type IpRecord, type Source } from "./types.js";
