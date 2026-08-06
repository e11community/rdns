import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { IpRecord } from "../src/types.js";

const ROOT = join(import.meta.dirname, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const CLI = join(ROOT, "src", "cli.ts");

let fakeHome: string;

// Minimal env: no CLOUDFLARE_API_TOKEN, no GCP_PROJECTS, no real HOME —
// the CLI only ever sees the temp home and its seeded cache.
function runCli(args: string[]): string {
  return execFileSync(TSX, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/** Same isolation as runCli, but keeps stderr (where progress is reported). */
function runCliStderr(args: string[]): string {
  return spawnSync(TSX, [CLI, ...args], {
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: fakeHome },
  }).stderr;
}

function seedCache(entries: Array<[string, IpRecord[]]>): void {
  const cacheDir = join(fakeHome, ".cache", "rdns");
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "index.json"),
    JSON.stringify({ builtAt: new Date().toISOString(), entries })
  );
}

beforeAll(() => {
  fakeHome = mkdtempSync(join(tmpdir(), "rdns-test-"));
});

// Re-seeded per test: the --refresh cases rebuild and overwrite the cache file.
beforeEach(() => {
  seedCache([
    [
      "203.0.113.7",
      [
        {
          ip: "203.0.113.7",
          source: "cloudflare-dns",
          name: "api.example.com",
          detail: "zone=example.com type=A proxied=false",
        },
        {
          ip: "203.0.113.7",
          source: "gcp-forwarding-rule",
          name: "xlb-fr",
          detail: "project=fake-project scope=global scheme=EXTERNAL_MANAGED ports=443 target=projects/fake-project/global/targetHttpsProxies/xlb",
        },
      ],
    ],
  ]);
});

afterAll(() => {
  rmSync(fakeHome, { recursive: true, force: true });
});

describe("rdns CLI", () => {
  it("prints help with no arguments", () => {
    const out = runCli([]);
    expect(out).toContain("rdns - Reverse DNS admin lookup");
    expect(out).toContain("USAGE");
  });

  it("uses the cache dir ~/.cache/rdns", () => {
    const out = runCli(["help"]);
    expect(out).toContain(join(fakeHome, ".cache", "rdns", "index.json"));
  });

  it("looks up an IP from the cache without touching any API", () => {
    const out = runCli(["lookup", "203.0.113.7"]);
    expect(out).toContain("203.0.113.7:");
    expect(out).toContain("[cloudflare-dns] api.example.com");
    expect(out).toContain("[gcp-forwarding-rule] xlb-fr");
  });

  it("reports NO MATCH for an unknown IP", () => {
    const out = runCli(["lookup", "198.51.100.99"]);
    expect(out).toContain("198.51.100.99: NO MATCH");
  });

  it("emits JSON with --json", () => {
    const out = runCli(["lookup", "203.0.113.7", "--json"]);
    const parsed = JSON.parse(out) as Record<string, IpRecord[]>;
    expect(parsed["203.0.113.7"]).toHaveLength(2);
    expect(parsed["203.0.113.7"][0].source).toBe("cloudflare-dns");
  });

  it("rebuilds an empty index when both scans are skipped", () => {
    const out = runCli([
      "lookup",
      "203.0.113.7",
      "--refresh",
      "--no-cloudflare",
      "--no-gcp",
    ]);
    expect(out).toContain("203.0.113.7: NO MATCH");
  });

  it("exits non-zero when lookup is given no IPs", () => {
    expect(() => runCli(["lookup"])).toThrow();
  });

  it("announces the start of the Cloudflare zone scan", () => {
    // The child env has no CLOUDFLARE_API_TOKEN, so the scan announces itself
    // and then fails the token check before making any network call.
    const stderr = runCliStderr(["scan", "--no-gcp"]);
    expect(stderr).toContain("[cloudflare] scanning zones...");
    expect(stderr).toContain("CLOUDFLARE_API_TOKEN env var is not set");
  });
});
