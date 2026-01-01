import { type ActionFunctionArgs } from "react-router";
import { NFSService } from "../services/nfs.server";
import { INK_NAMESPACE } from "../utils/metafields.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  // 1. Get raw body for HMAC verification
  const rawBody = await request.text();
  const signature = request.headers.get("X-INK-Signature");

  console.log("📩 Received ink. Webhook");

  // 2. Verify Signature
  if (!signature || !NFSService.verifyWebhookSignature(rawBody, signature)) {
    console.error("❌ Invalid ink. Webhook Signature");
    return new Response(JSON.stringify({ error: "Invalid signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" }
    });
  }

  // 3. Parse Payload
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch (e) {
    console.error("❌ Invalid JSON payload");
    return new Response(JSON.stringify({ error: "Invalid JSON" }), {
      status: 400,
      headers: { "Content-Type": "application/json" }
    });
  }

  const {
    order_id,
    status,
    delivery_gps,
    gps_verdict,
    proof_ref,
    timestamp,
    verify_url,
  } = payload;

  console.log(`Processing verification for Order ${order_id}`, payload);

  // 4. Get Shopify Admin Client using offline session
  try {
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    // Find an offline session (usually one per shop)
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
    });

    if (!session) {
      console.error("❌ No offline session found to process webhook");
      return new Response(JSON.stringify({ error: "No session" }), {
        status: 500,
        headers: { "Content-Type": "application/json" }
      });
    }

    // Create admin client with graphql method
    const client = {
      request: async (query: string, options?: any) => {
        const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables || {},
          }),
        });

        return await response.json();
      },
    };

    // 5. Update Metafields
    // Extract numeric ID from order_id (e.g., "ORDER-12345" → "12345")
    const numericOrderId = order_id.replace(/\D/g, '');
    const orderGid = `gid://shopify/Order/${numericOrderId}`;

    const metafields = [
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "verification_status",
        type: "single_line_text_field",
        value: status, // "verified"
      },
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "delivery_gps",
        type: "json",
        value: JSON.stringify(delivery_gps),
      },
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "proof_reference",
        type: "single_line_text_field",
        value: proof_ref,
      },
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "gps_verdict",
        type: "single_line_text_field",
        value: gps_verdict,
      },
    ];

    // Execute Metafield Update
    const mutation = `
      mutation SetMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;

    await client.request(mutation, { variables: { metafields } });
    await prisma.$disconnect();

    console.log(`✅ Metafields updated for Order ${order_id}`);
    return new Response(JSON.stringify({ success: true }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error) {
    console.error("❌ Error processing webhook:", error);
    return new Response(JSON.stringify({ error: "Processing failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
