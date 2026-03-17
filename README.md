# x402-worker-middleware

**POC 1 — Stable402**

A Cloudflare Worker that gates a JSON API endpoint behind [x402](https://x402.org) — the HTTP 402 payment protocol for machine-to-machine commerce.

An AI agent (or any HTTP client) sends a request → receives HTTP 402 with payment requirements → signs with a CDP wallet → retries with payment → receives the content. Settlement on Base Sepolia.

→ **Reference page:** [stable402.com/demos/gate](https://stable402.com/demos/gate)

---

## Architecture

```
Client                    Worker (this repo)              CDP Facilitator
  │                              │                               │
  ├─ GET /gate ─────────────────→│                               │
  │                              ├─ 402 + PAYMENT-REQUIRED ─────→│
  │←─ HTTP 402 ──────────────────┤  (base64 PaymentRequired)     │
  │  PAYMENT-REQUIRED header     │                               │
  │                              │                               │
  ├─ GET /gate ─────────────────→│                               │
  │  PAYMENT-SIGNATURE header    ├─ POST /verify ───────────────→│
  │  (EIP-3009 authorization)    │←─ verification result ────────┤
  │                              │                               │
  │←─ HTTP 200 ──────────────────┤
  │  PAYMENT-RESPONSE header     │
  │  + JSON payload              │
```

**Stack:**
- [Hono](https://hono.dev) — lightweight Worker framework
- [`@x402/hono`](https://www.npmjs.com/package/@x402/hono) — `paymentMiddlewareFromConfig`
- [`@x402/core`](https://www.npmjs.com/package/@x402/core) — `HTTPFacilitatorClient`
- Coinbase CDP facilitator — EIP-3009 verification (free tier, no API key required)

**Network:** Base Sepolia testnet (`eip155:84532`)
**Asset:** USDC on Base Sepolia (`0x036CbD53842c5426634e7929541eC2318f3dCF7e`)
**Price:** 1000 base units = $0.001 USDC

---

## Quickstart

### Prerequisites

- [Node.js](https://nodejs.org) 20+
- [Wrangler](https://developers.cloudflare.com/workers/wrangler/) (`npm install -g wrangler`)
- A Cloudflare account
- A wallet address on Base Sepolia funded with test USDC

### Install

```bash
npm install
```

### Set wallet address secret

```bash
npx wrangler secret put WALLET_ADDRESS
# Enter your Base Sepolia wallet address when prompted
# e.g. 0x22F637cF55217cb00252dDCF0c61FC4EfC12682c
```

### Run locally

```bash
npm run dev
```

Test locally (expects HTTP 402 — no payment signature):

```bash
curl -i http://localhost:8787/gate
```

### Deploy

```bash
npm run deploy
```

---

## Testing the 402 flow

**Step 1 — Confirm the gate is working (expect HTTP 402):**

```bash
curl -i https://api.stable402.com/gate
```

You should receive:
```
HTTP/2 402
payment-required: <base64-encoded PaymentRequired object>
```

**Step 2 — Decode the payment requirements:**

```bash
curl -s https://api.stable402.com/gate -o /dev/null -D - | \
  grep -i payment-required | \
  awk '{print $2}' | \
  base64 -d | jq .
```

**Step 3 — Pay and access** (requires a configured CDP wallet client — see [Coinbase x402 Quickstart for Buyers](https://docs.cdp.coinbase.com/x402/quickstart-for-buyers))

---

## Key implementation notes

**`paymentMiddlewareFromConfig` per-request pattern**

In Cloudflare Workers, `env` bindings (including `WALLET_ADDRESS`) are only available at request time, not at module load. This Worker creates the middleware inside `app.use('/gate', ...)` to access `c.env.WALLET_ADDRESS`. `HTTPFacilitatorClient` is lightweight and safe to instantiate per-request.

**`syncFacilitatorOnStart: false`**

Cloudflare Workers are stateless and ephemeral — there is no meaningful "startup" to sync with. Setting this to `false` skips the initialization fetch to the CDP facilitator.

**Price as `AssetAmount`**

Using `{ asset: USDC_ADDRESS, amount: '1000' }` instead of a money string makes the exact token and base-unit amount explicit — important for a reference implementation where the encoding must be transparent.

---

## Project structure

```
x402-worker-middleware/
├── src/
│   └── index.ts        # Hono app with paymentMiddlewareFromConfig
├── wrangler.toml       # Worker config (routes api.stable402.com/*)
├── package.json
├── tsconfig.json
└── README.md
```

---

## Part of Stable402

This repo is POC 1 in the [Stable402](https://stable402.com) reference implementation series for the x402 agentic payment ecosystem. Every POC ships with a companion reference page explaining the architecture, code, and protocol decisions in depth.

→ [stable402.com](https://stable402.com) · [github.com/Stable402](https://github.com/Stable402)
