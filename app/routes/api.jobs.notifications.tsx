import { type LoaderFunctionArgs } from "react-router";
import firestore from "../firestore.server";
import { NotificationService, type NotificationType } from "../services/notifications.server";
import { INK_NAMESPACE } from "../utils/metafields.server";

/**
 * Background Polling Job: Notifications Worker
 * URL: GET /api/jobs/notifications
 * 
 * Scheduled to run every 15-30 minutes.
 * Scans all stores for active INK orders and dispatches time-delayed reminders.
 */

// Simple basic auth or secret key for cron
const CRON_SECRET = process.env.CRON_SECRET || "cron_dev_secret";

function isAuthorized(request: Request) {
  const url = new URL(request.url);
  const authHeader = request.headers.get("Authorization");
  if (url.searchParams.get("secret") === CRON_SECRET) return true;
  if (authHeader === `Bearer ${CRON_SECRET}`) return true;
  return false;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (!isAuthorized(request)) {
    return new Response("Unauthorized", { status: 401 });
  }

  console.log("\n🔄 [CRON - Notifications] Starting scheduled polling iteration...");

  const sessionSnapshot = await firestore.collection("shopify_sessions").where("isOnline", "==", false).get();
  if (sessionSnapshot.empty) {
    console.log("No active offline Shopify sessions found.");
    return new Response(JSON.stringify({ triggered: 0, status: "no_sessions" }), { headers: { "Content-Type": "application/json" } });
  }

  let totalDispatched = 0;

  for (const sessionDoc of sessionSnapshot.docs) {
    const session = sessionDoc.data();
    if (!session.accessToken) continue;

    console.log(`\n🏪 [Store: ${session.shop}] Checking for pending notifications...`);

    // Fetch Merchant Notification Settings
    let settings = null;
    let merchantName = session.shop;
    const settingsSnap = await firestore.collection("merchants").where("shopDomain", "==", session.shop).limit(1).get();
    if (!settingsSnap.empty) {
      settings = settingsSnap.docs[0].data().notification_settings;
      merchantName = settingsSnap.docs[0].data().shopName || session.shop;
    }

    if (!settings) {
      console.log(`⚠️ Disabled: Merchant ${session.shop} has no notification settings configured.`);
      continue;
    }

    // 1. Fetch all orders tagged with INK that are fulfilled
    // We fetch their metafields to check our internal Notification Ledger
    const query = `#graphql
      query GetActiveInkOrders {
        orders(first: 50, query: "tag:INK AND fulfillment_status:shipped") {
          edges {
            node {
              id
              name
              email
              phone
              customer {
                firstName
                email
                phone
              }
              statusMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "verification_status") { value }
              proofMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "proof_reference") { value }
              ledgerMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "notification_ledger") { value }
            }
          }
        }
      }
    `;

    try {
      const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": session.accessToken,
        },
        body: JSON.stringify({ query }),
      });

      const json = await response.json();
      const orders = json.data?.orders?.edges || [];

      if (orders.length === 0) {
         console.log(`   No active shipped INK orders found.`);
         continue;
      }

      for (const edge of orders) {
        const order = edge.node;
        const proofRef = order.proofMetafield?.value;
        const status = order.statusMetafield?.value;
        const ledgerValue = order.ledgerMetafield?.value;
        const ledger = ledgerValue ? JSON.parse(ledgerValue) : {};

        // If verified, we stop all tap reminders (but check return warnings if applicable)
        const isVerified = status === "verified" || status === "valid";

        if (!proofRef) continue;

        // Fetch the absolute freshest state from Alan's DB via API
        const ALAN_API = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
        let alanVerifyUrl = "";
        let alanDeliveredAt: Date | null = null;
        let alanReturnExpiresAt: Date | null = null;

        try {
          // You need the API Key of the merchant to call Alan's API safely
          const apiKey = settingsSnap.docs[0].data()?.ink_api_key;
          if (!apiKey) continue;

          // GET /api/proofs/{proofRef}
          const alanResp = await fetch(`${ALAN_API}/proofs/${proofRef}`, {
            headers: { "Authorization": `Bearer ${apiKey}` }
          });
          
          if (alanResp.ok) {
            const alanData = await alanResp.json();
            alanVerifyUrl = alanData.verify_url;
            if (alanData.delivered_at) alanDeliveredAt = new Date(alanData.delivered_at);
            if (alanData.interaction_window_closed_at) alanReturnExpiresAt = new Date(alanData.interaction_window_closed_at);
          }
        } catch (e) {
          console.warn(`Could not sync Alan state for ${proofRef}`);
        }

        // --- MATH AND DISPATCH CALCULATION ---
        const now = new Date();
        const customerEmail = order.customer?.email || order.email;
        const customerPhone = order.customer?.phone || order.phone;
        const customerName = order.customer?.firstName || "Customer";
        const returnWindowDays = settings.returnWindow ? parseInt(settings.returnWindow) : 30;

        const dispatchIfReady = async (type: NotificationType, timeRequired: Date) => {
          if (ledger[type]) return; // Already sent! Prevent spam.
          if (now >= timeRequired) {
            console.log(`   ⏰ Triggering [${type}] for ${order.name}`);
            const sent = await NotificationService.dispatch({
              type,
              toEmail: customerEmail,
              toPhone: customerPhone,
              customerName,
              orderName: order.name,
              merchantName,
              verifyUrl: alanVerifyUrl,
              returnWindowDays
            }, settings);

            if (sent) {
              ledger[type] = new Date().toISOString();
              // Update Shopify Ledger Metafield
              const mutation = `#graphql
                mutation UpdateLedger($metafields: [MetafieldsSetInput!]!) {
                  metafieldsSet(metafields: $metafields) { userErrors { message } }
                }
              `;
              await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
                method: "POST",
                headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": session.accessToken },
                body: JSON.stringify({
                  query: mutation,
                  variables: {
                    metafields: [{
                      ownerId: order.id,
                      namespace: INK_NAMESPACE,
                      key: "notification_ledger",
                      type: "json",
                      value: JSON.stringify(ledger)
                    }]
                  }
                })
              });
              totalDispatched++;
            }
          }
        };

        // If NOT verified, check TAP Reminders
        if (!isVerified && alanDeliveredAt) {
          const hours4Time = new Date(alanDeliveredAt.getTime() + 4 * 60 * 60 * 1000);
          const hours24Time = new Date(alanDeliveredAt.getTime() + 24 * 60 * 60 * 1000);
          const hours48Time = new Date(alanDeliveredAt.getTime() + 48 * 60 * 60 * 1000);

          await dispatchIfReady("hours4", hours4Time);
          await dispatchIfReady("hours24", hours24Time);
          await dispatchIfReady("hours48", hours48Time);
        }

        // If VERIFIED, check RETURN WARNING Reminders
        if (isVerified && alanDeliveredAt) {
          // Natively calculate expiration time using Merchant's custom M7 returnWindowDays (rather than relying on Alan's generic interaction_window_closed_at)
          const trueReturnExpiresAt = new Date(alanDeliveredAt.getTime() + returnWindowDays * 24 * 60 * 60 * 1000);
          const days7Time = new Date(trueReturnExpiresAt.getTime() - 7 * 24 * 60 * 60 * 1000);
          const hours48PriorTime = new Date(trueReturnExpiresAt.getTime() - 48 * 60 * 60 * 1000);

          await dispatchIfReady("return7d", days7Time);
          await dispatchIfReady("return48h", hours48PriorTime);
        }
      }
    } catch (e: any) {
      console.error(`❌ Error scanning store ${session.shop}:`, e.message);
    }
  }

  console.log(`\n✅ [CRON - Notifications] Iteration complete. Dispatched ${totalDispatched} alerts.`);
  return new Response(JSON.stringify({ success: true, dispatched: totalDispatched }), { headers: { "Content-Type": "application/json" } });
};
