/**
 * x402-worker-middleware — Cloudflare Worker
 * Route: api.stable402.com/*
 *
 * POC 1: x402 Worker Middleware
 * Implements the x402 V2 payment handshake explicitly on Cloudflare Workers using Hono.
 *
 * Why explicit rather than @x402/hono paymentMiddlewareFromConfig?
 *   @x402/hono's sync-on-start behavior requires a persistent facilitator handshake
 *   that doesn't map cleanly to stateless Worker invocations. The explicit pattern
 *   below implements the same handshake with every step visible and commented —
 *   which is the point of a reference implementation.
 *
 * The handshake uses @x402/core types for structural correctness, and calls the
 * CDP facilitator directly for payment verification.
 *
 * Network: Base Sepolia testnet (eip155:84532)
 * Asset:   USDC on Base Sepolia (0x036CbD53842c5426634e7929541eC2318f3dCF7e)
 *
 * Setup:
 *   npx wrangler secret put WALLET_ADDRESS   ← your Base wallet address
 *   npm run deploy
 *
 * Test (no payment — expect HTTP 402):
 *   curl -i https://api.stable402.com/gate
 *
 * Reference: https://stable402.com/demos/gate
 */

import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { PaymentRequired, PaymentRequirements, VerifyResponse } from '@x402/core/types';
import type { ResourceInfo } from '@x402/core/types';

// ── Types ──────────────────────────────────────────────────────────────────

type Env = {
  /** Base wallet address that receives USDC payments. Set via: wrangler secret put WALLET_ADDRESS */
  WALLET_ADDRESS: string;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Coinbase CDP facilitator — verify endpoint. Free tier: 1,000 tx/month, no API key required. */
const CDP_VERIFY_URL = 'https://api.cdp.coinbase.com/platform/v2/x402/verify';

/** USDC token contract address on Base Sepolia */
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Base Sepolia testnet — CAIP-2 chain ID format required by x402 */
const BASE_SEPOLIA = 'eip155:84532' as const;

/** Price: 1000 USDC base units = 0.001 USDC (USDC has 6 decimal places) */
const GATE_PRICE = '1000';

const GATE_RESOURCE = 'https://api.stable402.com/gate';

// ── App ────────────────────────────────────────────────────────────────────

const app = new Hono<{ Bindings: Env }>();

// CORS — required for browser-based x402 clients hitting the API directly
app.use(
  '*',
  cors({
    origin: '*',
    allowMethods: ['GET', 'OPTIONS'],
    allowHeaders: ['Content-Type', 'PAYMENT-SIGNATURE'],
    exposeHeaders: ['PAYMENT-REQUIRED', 'PAYMENT-RESPONSE'],
  })
);

// ── Payment Gate: /gate ────────────────────────────────────────────────────

/**
 * GET /gate — x402 payment-gated endpoint.
 *
 * The x402 V2 handshake (two-pass):
 *
 * Pass 1 — No PAYMENT-SIGNATURE header:
 *   → Returns HTTP 402 with PAYMENT-REQUIRED header
 *   → Header value: base64(JSON(PaymentRequired))
 *   → PaymentRequired describes: scheme, network, asset, amount, payTo, timeout
 *
 * Pass 2 — PAYMENT-SIGNATURE header present:
 *   → Decodes the base64 signature header → PaymentPayload
 *   → POSTs to CDP facilitator: { paymentPayload, paymentRequirements }
 *   → Facilitator verifies the EIP-3009 authorization on-chain
 *   → On success: returns 200 with gated content + PAYMENT-RESPONSE header
 *   → On failure: returns 402 with error detail
 */
app.get('/gate', async (c) => {
  const paymentSignature = c.req.header('PAYMENT-SIGNATURE');

  // PaymentRequirements describes what the client must pay.
  // This is sent in the PAYMENT-REQUIRED header and also sent to the
  // facilitator during verification (so it can confirm the payment matches).
  const requirements: PaymentRequirements = {
    scheme: 'exact',
    network: BASE_SEPOLIA,
    amount: GATE_PRICE,      // base units (not maxAmountRequired — that's the V1 field name)
    payTo: c.env.WALLET_ADDRESS,
    maxTimeoutSeconds: 60,
    asset: USDC_BASE_SEPOLIA,
    extra: { name: 'USDC', version: '2' },
  };

  // ResourceInfo travels in PaymentRequired (not duplicated in each PaymentRequirements).
  const resource: ResourceInfo = {
    url: GATE_RESOURCE,
    description:
      'Access to the x402 basic gate reference endpoint. Returns a demonstration payload.',
    mimeType: 'application/json',
  };

  // ── Pass 1: No payment — return 402 ─────────────────────────────────────
  if (!paymentSignature) {
    // PaymentRequired wraps the requirements in the x402 envelope.
    // The client reads this to know what payment to sign.
    const paymentRequired: PaymentRequired = {
      x402Version: 2,
      resource,
      accepts: [requirements],
    };

    // Base64-encode the JSON payload for the PAYMENT-REQUIRED header.
    // Clients decode this with: JSON.parse(atob(header))
    const encoded = btoa(JSON.stringify(paymentRequired));

    return new Response(null, {
      status: 402,
      statusText: 'Payment Required',
      headers: {
        'PAYMENT-REQUIRED': encoded,
        'Content-Type': 'application/json',
      },
    });
  }

  // ── Pass 2: Payment present — verify with CDP facilitator ────────────────
  try {
    // The PAYMENT-SIGNATURE header value is base64(JSON(PaymentPayload)).
    // Send it to the CDP facilitator along with the requirements so it can
    // verify: (a) the signature is valid, (b) it covers the correct asset/amount,
    // (c) the authorization hasn't expired, (d) the payTo address matches.
    const verifyResponse = await fetch(CDP_VERIFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        paymentPayload: paymentSignature,
        paymentRequirements: requirements,
      }),
    });

    // Facilitator rejection is a valid protocol state — not a server error.
    // Return 402 (not 500) so the client can inspect the failure reason.
    if (!verifyResponse.ok) {
      const detail = await verifyResponse.text().catch(() => 'Facilitator error');
      return c.json({ error: 'Payment verification failed', detail }, 402);
    }

    const settlement = (await verifyResponse.json()) as VerifyResponse;

    // Add PAYMENT-RESPONSE header: base64(JSON(VerifyResponse))
    // This is the settlement confirmation the client can store as proof of payment.
    const settlementEncoded = btoa(JSON.stringify(settlement));

    return new Response(
      JSON.stringify({
        message: 'Payment verified. Welcome to the x402 basic gate.',
        endpoint: 'api.stable402.com/gate',
        protocol: 'x402 V2',
        facilitator: 'Coinbase CDP (Base Sepolia)',
        timestamp: new Date().toISOString(),
        documentation: 'https://stable402.com/demos/gate',
      }),
      {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
          'PAYMENT-RESPONSE': settlementEncoded,
        },
      }
    );
  } catch (err) {
    console.error('Gate handler error:', err);
    return c.json({ error: 'Internal error during payment verification' }, 500);
  }
});

// ── Coming-Soon Stubs ──────────────────────────────────────────────────────
// These endpoints expand as POCs ship.

app.get('/tiered', (c) =>
  c.json({ status: 'coming_soon', demo: 'Rate-Tiered Access — POC 1b' })
);

app.get('/mcp', (c) =>
  c.json({ status: 'coming_soon', demo: 'paidTool MCP Server — POC 2' })
);

// ── 404 ────────────────────────────────────────────────────────────────────

app.notFound((c) => c.json({ error: 'Not found' }, 404));

export default app;
