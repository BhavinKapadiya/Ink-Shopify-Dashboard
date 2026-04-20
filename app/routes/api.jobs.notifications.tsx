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
        orders(first: 200, query: "fulfillment_status:shipped AND status:any") {
          edges {
            node {
              id
              name
              email
              phone
              shippingAddress {
                phone
              }
              statusPageUrl
              customer {
                firstName
                email
                phone
              }
              statusMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "verification_status") { value }
              proofMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "proof_reference") { value }
              ledgerMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "notification_ledger") { value }
              deliveredAtMetafield: metafield(namespace: "${INK_NAMESPACE}", key: "delivered_at") { value }
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

      if (json.errors) {
         console.warn(`   ⚠️ GraphQL Errors querying orders:`, JSON.stringify(json.errors, null, 2));
      }

      console.log(`   🔍 Shopify Search Query ("fulfillment_status:shipped") found ${orders.length} orders.`);

      if (orders.length === 0) {
         console.log(`   ❌ No active shipped INK orders found.`);
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

        // Fetch the delivery state natively from Shopify Metafields
        const deliveredAtValue = order.deliveredAtMetafield?.value;
        let alanDeliveredAt: Date | null = deliveredAtValue ? new Date(deliveredAtValue) : null;
        let alanReturnExpiresAt: Date | null = null;
        const returnWindowDays = settings.returnWindow ? parseInt(settings.returnWindow) : 30;

        // If delivered, calculate the expiration date physically on our server
        if (alanDeliveredAt) {
          alanReturnExpiresAt = new Date(alanDeliveredAt.getTime() + returnWindowDays * 24 * 60 * 60 * 1000);
        }

        // --- MATH AND DISPATCH CALCULATION ---
        const now = new Date();
        const customerEmail = order.email || order.customer?.email;
        const customerPhone = order.shippingAddress?.phone || order.phone || order.customer?.phone;
        
        console.log(`   📊 Order Data: isVerified=${isVerified}, deliveredAt=${alanDeliveredAt}, status="${status}", returnExpires=${alanReturnExpiresAt}`);
        console.log(`   📒 Ledger state:`, ledger);

        const customerName = order.customer?.firstName || "Customer";

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
              verifyUrl: order.statusPageUrl,
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
          // DEV HACKS: 5 min, 10 mins, 15 mins
          const hours4Time = new Date(alanDeliveredAt.getTime() + 5 * 60 * 1000);
          const hours24Time = new Date(alanDeliveredAt.getTime() + 10 * 60 * 1000);
          const hours48Time = new Date(alanDeliveredAt.getTime() + 15 * 60 * 1000);

          await dispatchIfReady("hours4", hours4Time);
          await dispatchIfReady("hours24", hours24Time);
          await dispatchIfReady("hours48", hours48Time);
        }

        // If VERIFIED, check RETURN WARNING Reminders
        if (isVerified && alanDeliveredAt) {
          // DEV HACKS: Overriding normal math (which requires 23+ days of waiting) 
          // to trigger instantly at exactly 5 and 10 minutes from delivery for simple developer checking!
          const days7Time = new Date(alanDeliveredAt.getTime() + 5 * 60 * 1000);
          const hours48PriorTime = new Date(alanDeliveredAt.getTime() + 10 * 60 * 1000);

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
