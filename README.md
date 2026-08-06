# rdns

Reverse DNS admin tool. Given an IPv4 (or IPv6) address — typically pasted out of a network vulnerability scanner alert — figure out **what it actually points to** in your environment.

Scans:
- **Cloudflare** — A and AAAA records across every zone the API token can see.
- **GCP** — VM internal/external IPs (v4 and v6), reserved IP addresses (regional + global), and load balancer front-ends (regional + global forwarding rules) for every project you list.

PTR records are not created or required — the tool does the reverse mapping itself by indexing forward records.

## Install

```bash
npm install
npm run build
npm link    # optional: puts `rdns` on PATH
```

Requires Node.js 24+ (`nvm use` picks it up from `.nvmrc`).

## Auth

### Cloudflare

Set `CLOUDFLARE_API_TOKEN`. The token needs **Zone:Read** and **DNS:Read** for every account/zone you want included.

### GCP

Application Default Credentials. Either:

```bash
gcloud auth application-default login
```

…or run on a VM/GKE pod whose attached service account has, at minimum:

- `compute.instances.list`
- `compute.addresses.list` and `compute.globalAddresses.list`
- `compute.forwardingRules.list` and `compute.globalForwardingRules.list`

The `roles/compute.viewer` predefined role covers all of these.

The Compute clients request a single OAuth scope, `https://www.googleapis.com/auth/compute.readonly` — the narrowest one that covers every list call `rdns` makes. Service accounts, workload identity, and VM metadata credentials are therefore held to read-only Compute access even if the underlying identity is granted more. (User credentials from `gcloud auth application-default login` carry their scopes in the refresh token, so that path is bounded by the login itself.)

> **Note:** GCP scans require an explicit project list — there is no "all projects" mode (Compute Engine APIs are project-scoped). Pass `-p <project>` repeatedly, or set `GCP_PROJECTS=proj-a,proj-b`.

## Usage

```bash
# One-shot lookup (scans on first run, then uses 15-min cache)
rdns lookup 35.190.12.45

# Multiple IPs at once
rdns lookup 35.190.12.45 10.20.30.40 2600:1901:0:abcd::

# Interactive — best for triaging a scanner report
rdns repl

# Force a fresh scan (e.g. after creating a new LB)
rdns scan
rdns lookup 35.190.12.45 --refresh

# Dump everything (useful for grep/jq pipelines)
rdns list --json | jq '.[] | select(.[1][].source == "gcp-forwarding-rule")'

# Specify projects on the CLI
rdns lookup 1.2.3.4 -p prod-platform -p prod-data
```

## Output format

```
35.190.12.45:
  [gcp-forwarding-rule] my-lb-https-fr
    project=prod-platform scope=global scheme=EXTERNAL_MANAGED ports=443 target=projects/prod-platform/global/targetHttpsProxies/my-lb
  [cloudflare-dns] api.example.com
    zone=example.com type=A proxied=false
```

Multiple hits for the same IP are common and expected — e.g. an unproxied Cloudflare A record pointing at a GCP global forwarding rule will surface in both scans.

## Cache

Stored at `~/.cache/rdns/index.json`. Default TTL is 15 minutes. Override with `--ttl <seconds>` or bypass entirely with `--refresh`.

## Library use

The scanners are also exported as a library (`src/index.ts` → `dist/index.js`):

```ts
import { scanCloudflare, scanGcp, type IpIndex } from "rdns";

const index: IpIndex = new Map();
await scanCloudflare(index);
await scanGcp(index, { projectId: "my-project" });
```

## Development

```bash
npm install
npm test        # vitest — Cloudflare/GCP SDKs are mocked; no credentials needed
npm run build   # tsc → dist/
```

## Known gaps

- **GKE Service-allocated IPs** are surfaced via the underlying forwarding rules / addresses created by the GKE controller, but the human-friendly names will be the controller-generated ones (e.g. `k8s2-fr-...`), not the Service name. If you need Service-name attribution, that's a separate scan against the Kubernetes API and is not implemented here.
- **Cloud NAT egress IPs** appear as `gcp-address` entries with `purpose=NAT_AUTO` or as reserved addresses bound to a NAT gateway — but the tool does not currently traverse the NAT → router relationship to label them as "NAT egress".
- **CNAMEs** are not resolved transitively. If your scanner reports an IP that resolves through a CNAME chain, the index will only show the terminal A/AAAA record's name.
