import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { NFSService } from "../services/nfs.server";
import { createMerchant } from "../services/ink-api.server";
import firestore from "../firestore.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, admin } = await authenticate.webhook(request);

  if (!admin) {
    return new Response("Unauthorized", { status: 401 });
  }

  const orderId = payload.id;
  if (!orderId) {
    console.error(`[${topic}] No order payload found.`);
    return new Response("Bad Request", { status: 400 });
  }

  const orderGid = `gid://shopify/Order/${orderId}`;
  console.log(`[${topic}] Webhook triggered for shop: ${shop}, orderGid: ${orderGid}`);

  try {
    // ── Step 1: Look up merchant's ink_api_key from Firestore ─────────────────
    let merchantApiKey: string | null = null;
    let merchantDocRef: FirebaseFirestore.DocumentReference | null = null;

    const merchantSnap = await firestore
      .collection("merchants")
      .where("shopDomain", "==", shop)
      .limit(1)
      .get();

    if (!merchantSnap.empty) {
      merchantDocRef = merchantSnap.docs[0].ref;
      merchantApiKey = merchantSnap.docs[0].data()?.ink_api_key || null;
    }

    if (!merchantApiKey) {
      console.error(`[${topic}] No ink_api_key found in Firestore for shop: ${shop}. Cannot mark delivered.`);
      return new Response("Merchant API key not found", { status: 500 });
    }
    console.log(`[${topic}] Found ink_api_key for ${shop} (prefix: ${merchantApiKey.slice(0, 12)}...)`);

    // ── Step 2: Fetch proof_reference metafield from Shopify ──────────────────
    const gqlResponse = await admin.graphql(`
      query GetOrderMetafield($id: ID!) {
        order(id: $id) {
          name
          updatedAt
          metafield(namespace: "ink", key: "proof_reference") {
            value
          }
        }
      }
    `, {
      variables: { id: orderGid }
    });

    const body = await gqlResponse.json();
    const proofReference = body.data?.order?.metafield?.value;
    const fulfilledAt = payload.updated_at || body.data?.order?.updatedAt || new Date().toISOString();

    // Carrier from Shopify fulfillment
    let carrier: string | undefined;
    if (payload.fulfillments && payload.fulfillments.length > 0) {
      carrier = payload.fulfillments[0].tracking_company || undefined;
    }

    if (!proofReference) {
      console.log(`[${topic}] Order ${orderGid} has no INK proof_reference metafield. Skipping (not an INK order).`);
      return new Response("OK", { status: 200 });
    }

    console.log(`[${topic}] Found proof_reference: ${proofReference} for order ${orderGid}. Marking as delivered.`);
    console.log(`📦 Marking delivery for proof ${proofReference}:`, { delivered_at: fulfilledAt, carrier });

    // ── Step 3: Call PATCH /api/proofs/:proof_id/delivered ────────────────────
    // If stored key is stale (401), provision a fresh key and retry ONCE.
    const markDeliveredWithRetry = async (apiKey: string): Promise<void> => {
      try {
        await NFSService.markDelivered(proofReference, apiKey, {
          delivered_at: fulfilledAt,
          carrier,
        });
        console.log(`[${topic}] ✅ Successfully pushed delivered state for proof: ${proofReference}`);
      } catch (markErr: any) {
        const isAuthError =
          markErr.message?.includes("401") ||
          markErr.message?.includes("Invalid API key");

        if (isAuthError && merchantDocRef) {
          console.warn(`[${topic}] ⚠️ API key rejected (401). Re-provisioning key for ${shop} and retrying...`);
          const freshMerchant = await createMerchant(shop, shop, `admin@${shop}`);
          const freshApiKey = freshMerchant?.api_key;
          if (!freshApiKey) {
            throw new Error(`Alan did not return a new api_key for ${shop}. Proof ${proofReference} cannot be marked delivered.`);
          }
          await merchantDocRef.update({ ink_api_key: freshApiKey, updatedAt: new Date() });
          console.log(`[${topic}] ✅ Fresh key provisioned. Retrying markDelivered...`);
          // Retry with fresh key — no further fallback
          await NFSService.markDelivered(proofReference, freshApiKey, {
            delivered_at: fulfilledAt,
            carrier,
          });
          console.log(`[${topic}] ✅ markDelivered succeeded after key refresh for proof: ${proofReference}`);
        } else {
          throw markErr;
        }
      }
    };

    await markDeliveredWithRetry(merchantApiKey);

    // ── Step 4: Natively stamp delivered_at to Shopify for Cron Job math ──
    const deliveredMutation = `#graphql
      mutation UpdateDeliveredTime($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) { userErrors { message } }
      }
    `;
    await admin.graphql(deliveredMutation, {
      variables: {
        metafields: [{
          ownerId: orderGid,
          namespace: "ink",
          key: "delivered_at",
          type: "date_time",
          value: new Date().toISOString()
        }]
      }
    });
    console.log(`[${topic}] ✅ Stamped ink.delivered_at natively to Shopify.`);

  } catch (error) {
    console.error(`[${topic}] Error processing fulfilled webhook:`, error);
    return new Response("Internal Server Error", { status: 500 });
  }

  return new Response("OK", { status: 200 });
};
