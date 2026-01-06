import type { ActionFunctionArgs } from "react-router";
import crypto from "crypto";

// Manual webhook secret from Shopify Admin webhook settings  
const MANUAL_WEBHOOK_SECRET = "054f24e3c411a8aa92b94aa244127309afe56a89b8f1993e996376abe8d0924b";

/**
 * Verify manual webhook HMAC signature
 */
function verifyManualWebhook(body: string, hmacHeader: string): boolean {
  const hash = crypto
    .createHmac("sha256", MANUAL_WEBHOOK_SECRET)
    .update(body, "utf8")
    .digest("base64");
  
  return hash === hmacHeader;
}

const TAG_MUTATION = `
mutation AddOrderTag($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors { field message }
  }
}
`;

const METAFIELD_MUTATION = `
mutation SetInkMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

/**
 * Check if order has INK Premium Delivery shipping method selected
 */
function hasInkPremiumShipping(shippingLines: any[]): boolean {
  for (const line of shippingLines || []) {
    const title = (line.title || line.name || "").toLowerCase();
    
    // Check for "INK Premium Delivery" or similar variations
    if (
      title.includes("ink premium") ||
      title.includes("ink delivery") ||
      (title.includes("premium delivery") && title.includes("ink"))
    ) {
      console.log(`✅ Found INK Premium Delivery: "${line.title}"`);
      return true;
    }
  }
  
  return false;
}

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("[orders/create] Webhook received");
  
  // Get HMAC header for manual webhook verification
  const hmacHeader = request.headers.get("X-Shopify-Hmac-SHA256");
  const shopDomain = request.headers.get("X-Shopify-Shop-Domain");
  
  // Get raw body for HMAC verification
  const rawBody = await request.text();
  
  // Verify HMAC signature
  if (!hmacHeader || !verifyManualWebhook(rawBody, hmacHeader)) {
    console.error("[orders/create] Invalid HMAC signature");
    return new Response("Unauthorized", { status: 401 });
  }
  
  console.log(`[orders/create] Authenticated - shop: ${shopDomain}`);
  
  // Parse payload
  const payload = JSON.parse(rawBody);
  const orderGid = payload?.admin_graphql_api_id as string | undefined;
  const orderName = payload?.name || payload?.order_number || "Unknown";

  if (!orderGid) {
    console.error("[orders/create] Missing order id");
    return new Response("Missing order", { status: 400 });
  }

  console.log(`\n📦 [orders/create] Processing order ${orderName} (${shopDomain})`);

  // DEBUG: Log full shipping data from payload
  console.log("🚢 DEBUG: Full shipping data:");
  console.log("  - shipping_lines:", JSON.stringify(payload?.shipping_lines, null, 2));

  // Check shipping lines from the webhook payload
  const shippingLines = payload?.shipping_lines || [];
  
  console.log(`🚢 DEBUG: Found ${shippingLines.length} shipping line(s)`);
  
  const hasPremiumDelivery = hasInkPremiumShipping(shippingLines);

  if (!hasPremiumDelivery) {
    console.log(`📦 [orders/create] Order ${orderName} has Standard Delivery - skipping INK protection`);
    return new Response("ok - standard delivery");
  }

  console.log(`🛡️ [orders/create] Order ${orderName} has INK Premium Delivery!`);

  // For manual webhooks, we need to create a GraphQL client with shop-specific session
  // This is a simplified version - you may need to get the session from your database
  try {
    // We'll use REST Admin API URL approach for tags since we don't have session
    const shopifyApiUrl = `https://${shopDomain}/admin/api/2024-10/graphql.json`;
    const accessToken = process.env.SHOPIFY_ACCESS_TOKEN; // You need to set this in .env
    
    if (!accessToken) {
      console.error("[orders/create] Missing SHOPIFY_ACCESS_TOKEN");
      return new Response("Configuration error", { status: 500 });
    }

    // Add tag using GraphQL Admin API
    const tagResponse = await fetch(shopifyApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: TAG_MUTATION,
        variables: {
          id: orderGid,
          tags: ["INK-Premium-Delivery"]
        }
      })
    });

    const tagResult = await tagResponse.json();
    console.log(`✅ [orders/create] Tagged order ${orderName} with "INK-Premium-Delivery"`);

    // Set initial metafields for INK Premium orders
    const metafieldResponse = await fetch(shopifyApiUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Shopify-Access-Token": accessToken,
      },
      body: JSON.stringify({
        query: METAFIELD_MUTATION,
        variables: {
          metafields: [
            {
              ownerId: orderGid,
              namespace: "ink",
              key: "verification_status",
              type: "single_line_text_field",
              value: "pending",
            },
            {
              ownerId: orderGid,
              namespace: "ink",
              key: "delivery_type",
              type: "single_line_text_field",
              value: "premium",
            },
            {
              ownerId: orderGid,
              namespace: "ink",
              key: "proof_reference",
              type: "single_line_text_field",
              value: "",
            },
            {
              ownerId: orderGid,
              namespace: "ink",
              key: "nfc_uid",
              type: "single_line_text_field",
              value: "",
            },
          ],
        }
      })
    });

    const metafieldResult = await metafieldResponse.json();
    const errors = metafieldResult?.data?.metafieldsSet?.userErrors;
    
    if (errors?.length) {
      console.error(`❌ [orders/create] Metafield errors for ${orderName}:`, errors);
    } else {
      console.log(`✅ [orders/create] Metafields initialized for ${orderName}`);
    }

  } catch (error) {
    console.error(`❌ [orders/create] Error processing ${orderName}:`, error);
    return new Response("Error processing order", { status: 500 });
  }

  console.log(`✅ [orders/create] Successfully processed premium delivery order ${orderName}\n`);
  return new Response("ok");
};
