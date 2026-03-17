/**
 * x402-worker-middleware — Cloudflare Worker
 * Route: api.stable402.com/*
 *
 * POC 1: x402 Worker Middleware
 * Implements the x402 V2 payment handshake using:
 *   - Hono as the Worker framework
 *   - @x402/hono paymentMiddlewareFromConfig for the 402 gate
 *   - Coinbase CDP facilitator for payment verification (free tier: 1,000 tx/month)
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
import { paymentMiddlewareFromConfig } from '@x402/hono';
import { HTTPFacilitatorClient } from '@x402/core/server';

// ── Types ──────────────────────────────────────────────────────────────────

type Env = {
  /** Base wallet address that receives USDC payments. Set via: wrangler secret put WALLET_ADDRESS */
  WALLET_ADDRESS: string;
};

// ── Constants ──────────────────────────────────────────────────────────────

/** Coinbase CDP facilitator — handles EIP-3009 verification and settlement on Base Sepolia. Free tier: 1,000 tx/month, no API key required. */
const CDP_FACILITATOR_URL = 'https://api.cdp.coinbase.com/platform/v2/x402';

/** USDC token contract address on Base Sepolia */
const USDC_BASE_SEPOLIA = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';

/** Base Sepolia testnet — CAIP-2 chain ID format required by x402 */
const BASE_SEPOLIA = 'eip155:84532' as const;

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
 * x402 payment middleware for GET /gate.
 *
 * The x402 handshake:
 *   1. Request arrives without PAYMENT-SIGNATURE
 *      → middleware returns HTTP 402 with base64-encoded PAYMENT-REQUIRED header
 *      → header contains: scheme, network, asset, amount, payTo, resource, timeout
 *
 *   2. Client reads the 402, signs an EIP-3009 transferWithAuthorization,
 *      encodes it as PAYMENT-SIGNATURE, and retries the request.
 *
 *   3. Middleware forwards the signature to the CDP facilitator for verification.
 *      → On success: calls next(), route handler below runs, PAYMENT-RESPONSE added
 *      → On failure: returns 402 with error detail
 *
 * Implementation note:
 *   paymentMiddlewareFromConfig is called per-request (inside app.use) because
 *   c.env.WALLET_ADDRESS is only available at request time in Cloudflare Workers —
 *   env bindings are not accessible at module load. HTTPFacilitatorClient is
 *   lightweight (no persistent connection) and safe to instantiate per-request.
 */
app.use('/gate', async (c, next) => {
  const facilitator = new HTTPFacilitatorClient({ url: CDP_FACILITATOR_URL });

  return paymentMiddlewareFromConfig(
    {
      '/gate': {
        accepts: {
          scheme: 'exact',
          payTo: c.env.WALLET_ADDRESS,
          // Price as AssetAmount: explicit asset address + amount in token base units.
          // USDC has 6 decimal places: 1000 base units = 0.001 USDC = $0.001
          price: {
            asset: USDC_BASE_SEPOLIA,
            amount: '1000',
          },
          network: BASE_SEPOLIA,
          maxTimeoutSeconds: 60,
        },
        description:
          'Access to the x402 basic gate reference endpoint. Returns a demonstration payload.',
        mimeType: 'application/json',
      },
    },
    facilitator,
    undefined, // schemes — CDP facilitator handles EVM verification; no custom scheme server needed
    undefined, // paywallConfig — browser paywall UI not needed for this API endpoint
    undefined, // paywall provider
    false // syncFacilitatorOnStart=false — Workers are stateless; no persistent startup fetch
  )(c, next);
});

/**
 * GET /gate — gated content
 *
 * Only reached after paymentMiddlewareFromConfig successfully verifies payment.
 * The PAYMENT-RESPONSE header (settlement confirmation) is added by the middleware.
 */
app.get('/gate', (c) => {
  return c.json({
    message: 'Payment verified. Welcome to the x402 basic gate.',
    endpoint: 'api.stable402.com/gate',
    protocol: 'x402 V2',
    facilitator: 'Coinbase CDP (Base Sepolia)',
    timestamp: new Date().toISOString(),
    documentation: 'https://stable402.com/demos/gate',
  });
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
