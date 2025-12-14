import { type ActionFunctionArgs } from "react-router";
import crypto from "crypto";
import { INK_NAMESPACE } from "../utils/metafields.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, X-INK-Signature, Authorization, Accept",
};

// Handle OPTIONS preflight
export const loader = async () => {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
};

/**
 * Webhook endpoint for Alan's NFS system
 * Receives verification events after /verify completes
 * 
 * NOTE: No local database update - Alan's API is the single source of truth
 * We only update Shopify Order metafields for display purposes
 */
export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("\n🔔 =================================================");
  console.log("🔔 WEBHOOK /ink/update RECEIVED");
  console.log("🔔 Time:", new Date().toISOString());
  console.log("🔔 Method:", request.method);
  console.log("🔔 =================================================\n");

  // We still need Prisma for Session table (Shopify auth)
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    // 1. Read raw body for HMAC verification
    const rawBody = await request.text();
    console.log("📥 Raw webhook body:", rawBody);

    // 2. Verify HMAC signature
    const signature = request.headers.get("X-INK-Signature");
    const HMAC_SECRET = process.env.NFS_HMAC_SECRET;

    if (!HMAC_SECRET) {
      console.error("❌ NFS_HMAC_SECRET not configured");
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Server configuration error" }),
        { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    if (!signature) {
      console.error("❌ Missing X-INK-Signature header");
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Missing signature" }),
        { status: 401, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // Verify HMAC
    const expectedSignature = crypto
      .createHmac("sha256", HMAC_SECRET)
      .update(rawBody)
      .digest("hex");

    if (signature !== expectedSignature) {
      console.error("❌ Invalid HMAC signature");
      console.error("Expected:", expectedSignature);
      console.error("Received:", signature);
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Invalid signature" }),
        { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    console.log("✅ HMAC signature verified");

    // 3. Parse webhook payload
    const payload = JSON.parse(rawBody);
    const {
      order_id,
      status,
      delivery_gps,
      gps_verdict,
      proof_ref,
      timestamp,
      verify_url,
    } = payload;

    console.log("📦 Webhook data:", {
      order_id,
      status,
      gps_verdict,
      proof_ref,
    });

    if (!order_id || !status) {
      console.error("❌ Missing required fields in webhook");
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Missing required fields" }),
        { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
      );
    }

    // NOTE: No local database update needed
    // Alan's API is the single source of truth for all proof data
    console.log("ℹ️ Skipping local DB update - Alan's API is source of truth");

    // 4. Update Shopify order metafields
    console.log("📝 Updating Shopify order metafields...");
    try {
      // Get Shopify session from database
      const session = await prisma.session.findFirst({
        where: { isOnline: false },
      });

      if (!session) {
        console.error("❌ No offline session found");
        await prisma.$disconnect();
        return new Response(
          JSON.stringify({ error: "No session available" }),
          { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
      }

      // Create admin client
      const adminGraphql = async (query: string, variables?: any) => {
        const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({ query, variables }),
        });
        return response.json();
      };

      const numericOrderId = order_id.replace(/\D/g, "");
      const orderGid = `gid://shopify/Order/${numericOrderId}`;

      const metafields = [
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "verification_status",
          type: "single_line_text_field",
          value: status,
        },
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "gps_verdict",
          type: "single_line_text_field",
          value: gps_verdict || "unknown",
        },
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "delivery_timestamp",
          type: "single_line_text_field",
          value: timestamp || new Date().toISOString(),
        },
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "verify_url",
          type: "single_line_text_field",
          value: verify_url || "",
        },
      ];

      if (proof_ref) {
        metafields.push({
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "proof_reference",
          type: "single_line_text_field",
          value: proof_ref,
        });
      }

      if (delivery_gps) {
        metafields.push({
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "delivery_gps",
          type: "json",
          value: JSON.stringify(delivery_gps),
        });
      }

      const mutation = `
        mutation SetVerificationMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            metafields {
              id
              namespace
              key
              value
            }
            userErrors {
              field
              message
            }
          }
        }
      `;

      const data = await adminGraphql(mutation, { metafields });

      if (data.data?.metafieldsSet?.userErrors?.length > 0) {
        console.error("⚠️ Shopify metafield errors:", data.data.metafieldsSet.userErrors);
      } else {
        console.log("✅ Shopify metafields updated successfully");
      }
    } catch (shopifyError: any) {
      console.error("❌ Shopify update failed:", shopifyError.message);
      // Don't fail the webhook - we got the data
    }

    await prisma.$disconnect();

    console.log("✅ Webhook processed successfully\n");

    // Return success to Alan
    return new Response(
      JSON.stringify({ success: true, message: "Webhook processed" }),
      { headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  } catch (error: any) {
    console.error("❌ Webhook processing error:", error);
    await prisma.$disconnect();
    return new Response(
      JSON.stringify({ error: error.message || "Webhook processing failed" }),
      { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
    );
  }
};
