#!/usr/bin/env node
import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { scanCloudflare } from "./cloudflare.js";
import { scanGcp } from "./gcp.js";
import type { IpIndex, IpRecord } from "./types.js";

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

const CACHE_DIR = join(homedir(), ".cache", "rdns-admin");
const CACHE_FILE = join(CACHE_DIR, "index.json");
const DEFAULT_TTL_MS = 15 * 60 * 1000; // 15 min — tuned for "scanner alert -> investigate" workflow

interface CacheFile {
  builtAt: string;
  entries: Array<[string, IpRecord[]]>;
}

function loadCache(maxAgeMs: number): IpIndex | null {
  if (!existsSync(CACHE_FILE)) return null;
  const ageMs = Date.now() - statSync(CACHE_FILE).mtimeMs;
  if (ageMs > maxAgeMs) return null;
  try {
    const data: CacheFile = JSON.parse(readFileSync(CACHE_FILE, "utf8"));
    return new Map(data.entries);
  } catch {
    return null;
  }
}

function saveCache(index: IpIndex): void {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
  const payload: CacheFile = {
    builtAt: new Date().toISOString(),
    entries: [...index.entries()],
  };
  writeFileSync(CACHE_FILE, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Build index
// ---------------------------------------------------------------------------

interface BuildOptions {
  gcpProjects: string[];
  skipCloudflare: boolean;
  skipGcp: boolean;
}

async function buildIndex(opts: BuildOptions): Promise<IpIndex> {
  const index: IpIndex = new Map();
  const tasks: Array<Promise<unknown>> = [];

  if (!opts.skipCloudflare) {
    tasks.push(
      scanCloudflare(index)
        .then((r) =>
          console.error(`[cloudflare] ${r.zones} zones, ${r.records} A/AAAA records`)
        )
        .catch((e: Error) => console.error(`[cloudflare] FAILED: ${e.message}`))
    );
  }

  if (!opts.skipGcp) {
    for (const project of opts.gcpProjects) {
      tasks.push(
        scanGcp(index, { projectId: project })
          .then((c) =>
            console.error(
              `[gcp:${project}] ${c.vms} VMs (${c.vmIps} IPs), ${c.addresses} addresses, ${c.forwardingRules} forwarding rules`
            )
          )
          .catch((e: Error) => console.error(`[gcp:${project}] FAILED: ${e.message}`))
      );
    }
  }

  await Promise.all(tasks);
  return index;
}

// ---------------------------------------------------------------------------
// Lookup
// ---------------------------------------------------------------------------

function lookup(index: IpIndex, ip: string): IpRecord[] {
  return index.get(ip.trim().toLowerCase()) ?? [];
}

function formatRecord(r: IpRecord): string {
  return `  [${r.source}] ${r.name}\n    ${r.detail}`;
}

function printLookup(ip: string, hits: IpRecord[]): void {
  if (hits.length === 0) {
    console.log(`${ip}: NO MATCH`);
    return;
  }
  console.log(`${ip}:`);
  for (const h of hits) console.log(formatRecord(h));
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

interface Args {
  command: "lookup" | "scan" | "list" | "repl" | "help";
  ips: string[];
  gcpProjects: string[];
  skipCloudflare: boolean;
  skipGcp: boolean;
  refresh: boolean;
  json: boolean;
  ttlMs: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    command: "help",
    ips: [],
    gcpProjects: (process.env.GCP_PROJECTS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    skipCloudflare: false,
    skipGcp: false,
    refresh: false,
    json: false,
    ttlMs: DEFAULT_TTL_MS,
  };

  if (argv.length === 0) return args;
  args.command = argv[0] as Args["command"];

  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case "--project":
      case "-p":
        args.gcpProjects.push(argv[++i]);
        break;
      case "--no-cloudflare":
        args.skipCloudflare = true;
        break;
      case "--no-gcp":
        args.skipGcp = true;
        break;
      case "--refresh":
      case "-r":
        args.refresh = true;
        break;
      case "--json":
        args.json = true;
        break;
      case "--ttl":
        args.ttlMs = Number(argv[++i]) * 1000;
        break;
      default:
        args.ips.push(a);
    }
  }

  return args;
}

function help(): void {
  console.log(`rdns - Reverse DNS admin lookup across Cloudflare DNS + GCP

USAGE
  rdns lookup <ip> [<ip>...]    Look up one or more IPs
  rdns repl                     Interactive prompt (best for triaging a scanner report)
  rdns scan                     Force a fresh scan and update the cache
  rdns list                     Print the entire index (all known IPs)
  rdns help                     This message

OPTIONS
  -p, --project <id>            GCP project to scan (repeatable). Default: $GCP_PROJECTS (comma-separated)
      --no-cloudflare           Skip Cloudflare scan
      --no-gcp                  Skip GCP scan
  -r, --refresh                 Bypass cache and rebuild
      --ttl <seconds>           Max cache age in seconds (default: 900)
      --json                    Output raw JSON

ENV
  CLOUDFLARE_API_TOKEN          Required unless --no-cloudflare. Needs Zone:Read + DNS:Read.
  GCP_PROJECTS                  Comma-separated default project list.
  Application Default Credentials must be set for GCP (gcloud auth application-default login).

CACHE
  ${CACHE_FILE}
`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function getIndex(args: Args): Promise<IpIndex> {
  if (!args.refresh) {
    const cached = loadCache(args.ttlMs);
    if (cached) {
      console.error(`[cache] using ${CACHE_FILE} (${cached.size} IPs)`);
      return cached;
    }
  }
  console.error(`[cache] rebuilding...`);
  const index = await buildIndex({
    gcpProjects: args.gcpProjects,
    skipCloudflare: args.skipCloudflare,
    skipGcp: args.skipGcp,
  });
  saveCache(index);
  console.error(`[cache] saved ${index.size} IPs to ${CACHE_FILE}`);
  return index;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.command === "help" || args.command === undefined) {
    help();
    return;
  }

  if (args.command === "scan") {
    args.refresh = true;
    await getIndex(args);
    return;
  }

  const index = await getIndex(args);

  if (args.command === "list") {
    if (args.json) {
      console.log(JSON.stringify([...index.entries()], null, 2));
      return;
    }
    for (const [ip, recs] of [...index.entries()].sort()) {
      printLookup(ip, recs);
    }
    return;
  }

  if (args.command === "lookup") {
    if (args.ips.length === 0) {
      console.error("lookup requires at least one IP");
      process.exit(2);
    }
    const out: Record<string, IpRecord[]> = {};
    for (const ip of args.ips) {
      const hits = lookup(index, ip);
      if (args.json) out[ip] = hits;
      else printLookup(ip, hits);
    }
    if (args.json) console.log(JSON.stringify(out, null, 2));
    return;
  }

  if (args.command === "repl") {
    const rl = createInterface({ input: stdin, output: stdout });
    console.error(`Index loaded: ${index.size} IPs. Paste IPs (one per line). Ctrl-D to exit.`);
    rl.setPrompt("ip> ");
    rl.prompt();
    for await (const line of rl) {
      const ip = line.trim();
      if (!ip) {
        rl.prompt();
        continue;
      }
      printLookup(ip, lookup(index, ip));
      rl.prompt();
    }
    return;
  }

  console.error(`Unknown command: ${args.command}`);
  help();
  process.exit(2);
}

main().catch((e: Error) => {
  console.error(`fatal: ${e.message}`);
  process.exit(1);
});
