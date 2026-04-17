import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import { getInventoryByShopDomain } from "../services/ink-api.server";
import crypto from "crypto";

/**
 * Public endpoint (authenticated by warehouse JWT only).
 * Reads inventory directly from Firestore sticker_inventory_ledger.
 *
 * GET /app/api/warehouse/inventory
 * Headers: Authorization: Bearer <warehouse_token>
 *
 * Response: { current_count, recent_transactions }
 */

const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    ...init,
  });

function verifyToken(token: string): { shop: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");
    if (signature !== expectedSig) return null;
    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch {
    return null;
  }
}

export async function loader({ request }: LoaderFunctionArgs) {
  // 1. Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  try {
    // 2. Auth Check
    const authHeader = request.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return json({ error: "Missing or invalid authorization header" }, { status: 401 });
    }

    const token = authHeader.split(" ")[1];
    const payload = verifyToken(token);
    
    let shopDomain = payload?.shop;
    
    if (!shopDomain) {
      // Decode without verification (if it's an INK JWT token)
      try {
        const decodedBody = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
        shopDomain = decodedBody.merchant_id || decodedBody.shop;
      } catch (e) {
        console.error("Failed to decode token", e);
      }
    }

    if (!shopDomain) {
      return json({ error: "Invalid token or missing shop domain" }, { status: 401 });
    }

    if (shopDomain && shopDomain.startsWith("shop_")) {
      try {
        const { getDomainByShopId } = await import("../services/ink-api.server");
        const resolvedDomain = await getDomainByShopId(shopDomain);
        if (resolvedDomain) {
            shopDomain = resolvedDomain;
        }
      } catch (e: any) {
        console.warn(`[INVENTORY] Could not resolve Shopify domain for ${shopDomain}: ${e.message}`);
      }
    }

    // 3. Fetch inventory directly from Firestore (no API key needed)
    const inventoryData = await getInventoryByShopDomain(shopDomain);

    return json(inventoryData);
  } catch (error: any) {
    console.error("Inventory error:", error);
    return json({ error: error.message || "Failed to fetch inventory" }, { status: 500 });
  }
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  return json({ error: "Method not allowed" }, { status: 405 });
}
