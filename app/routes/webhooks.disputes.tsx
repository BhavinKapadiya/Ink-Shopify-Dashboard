import { authenticate } from "../shopify.server";
import firestore from "../firestore.server";

const INK_API_URL = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";

function getAlanUrl(path: string): string {
  const baseUrl = INK_API_URL.endsWith('/') ? INK_API_URL.slice(0, -1) : INK_API_URL;
  if (path.startsWith('/api/') && baseUrl.endsWith('/api')) {
    return `${baseUrl.slice(0, -4)}${path}`;
  }
  return `${baseUrl}${path}`;
}

export const action = async ({ request }: any) => {
    // 1. Authenticate the Shopify Webhook payload
    const { topic, shop, session, payload } = await authenticate.webhook(request);
    
    console.log(`\n⚖️ [WEBHOOK] ============================================`);
    console.log(`⚖️ [WEBHOOK] Received Event: ${topic}`);
    console.log(`⚖️ [WEBHOOK] Processing Dispute for Shop: ${shop}`);
    console.log(`⚖️ [WEBHOOK] Order ID: ${payload.order_id}`);
    
    try {
        // Extract dispute data
        const orderId = payload.order_id?.toString();
        
        if (!orderId) {
            console.warn(`⚖️ [WEBHOOK] ⚠️ Missing order_id in dispute payload.`);
            return new Response();
        }

        const disputePayload = {
            dispute_type: payload.type || "chargeback",
            dispute_source: "shopify",
            dispute_amount: payload.amount,
            dispute_reason_code: payload.reason,
            dispute_reason: "Chargeback via Shopify",
            dispute_outcome: payload.status,
            ink_evidence_submitted: false
        };

        console.log(`⚖️ [WEBHOOK] Extracted Dispute Payload:`, JSON.stringify(disputePayload, null, 2));

        // 2. Fetch Merchant API Key from Firestore
        const merchantSnap = await firestore
            .collection("merchants")
            .where("shopDomain", "==", shop)
            .limit(1)
            .get();

        if (merchantSnap.empty) {
             console.error(`⚖️ [WEBHOOK] ❌ Firestore merchant not found for ${shop}. Cannot forward to INK.`);
             return new Response();
        }

        const merchantData = merchantSnap.docs[0].data();
        const apiKey = merchantData.ink_api_key;

        if (!apiKey || apiKey === "sk_test_fallback") {
             console.error(`⚖️ [WEBHOOK] ❌ Invalid or missing ink_api_key for ${shop}. Cannot forward to INK.`);
             return new Response();
        }

        console.log(`⚖️ [WEBHOOK] Found API Key ending in ...${apiKey.slice(-5)}`);

        // 3. Forward to Alan's Backend
        const disputeUrl = getAlanUrl(`/api/proofs/${orderId}/dispute`);
        console.log(`⚖️ [WEBHOOK] Routing to INK Backend → ${disputeUrl}`);

        const response = await fetch(disputeUrl, {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${apiKey}`
            },
            body: JSON.stringify(disputePayload)
        });

        console.log(`⚖️ [WEBHOOK] INK Response Status: ${response.status}`);
        
        if (!response.ok) {
            const rawBody = await response.text();
            console.error(`⚖️ [WEBHOOK] ❌ INK API Request Failed: ${rawBody}`);
        } else {
            console.log(`⚖️ [WEBHOOK] ✅ INK Backend processed dispute and updated Metabase revenue charts.`);
        }
    } catch (err: any) {
        console.error(`⚖️ [WEBHOOK] ❌ Fatal Error during dispute forwarding:`, err.message);
    }

    console.log(`⚖️ [WEBHOOK] ============================================\n`);
    return new Response();
};
