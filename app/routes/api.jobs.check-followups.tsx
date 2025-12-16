
import { type LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { SMSService } from "../services/sms.server";
import { INK_NAMESPACE } from "../utils/metafields.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  console.log("⏰ Checking for 24h SMS follow-ups...");

  try {
    // 1. Authenticate with Shopify Admin
    // This job should be triggered with a valid session or API token
    // For simplicity, we assume this is called via a scheduled job with admin access
    const { admin } = await authenticate.admin(request);

    // 2. Fetch recent delivered orders (last 72 hours)
    // We fetch more than 24h to ensure we catch any we missed
    const query = `#graphql
      query GetRecentDeliveredOrders {
        orders(first: 50, query: "fulfillment_status:shipped AND status:open") {
          edges {
            node {
              id
              name
              displayFulfillmentStatus
              createdAt
              customer {
                phone
                firstName
              }
              metafields(namespace: "${INK_NAMESPACE}", first: 10) {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
              fulfillments(first: 1) {
                edges {
                  node {
                    deliveredAt
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await admin.graphql(query);
    const result = await response.json();
    const orders = result.data?.orders?.edges || [];

    console.log(`🔍 Found ${orders.length} potential orders to check.`);

    let processedCount = 0;
    const now = new Date();

    for (const edge of orders) {
      const order = edge.node;
      const orderId = order.id;
      const customerPhone = order.customer?.phone;
      const fulfillments = order.fulfillments?.edges || [];
      const deliveryDateStr = fulfillments[0]?.node?.deliveredAt;

      // Extract metafields
      const metafields: Record<string, string> = {};
      order.metafields.edges.forEach((edge: any) => {
        metafields[edge.node.key] = edge.node.value;
      });

      const isVerified = metafields.verification_status === "verified";
      const followupSent = metafields.followup_sent === "true";
      const isEnrolled = metafields.verification_status === "enrolled";

      // Logic:
      // 1. Must be delivered
      // 2. Must be enrolled (but not verified)
      // 3. Must NOT have sent followup yet
      // 4. Must be > 24 hours since delivery (production mode) OR test mode active

      if (!deliveryDateStr) continue; // Not delivered yet

      const deliveredAt = new Date(deliveryDateStr);
      const hoursSinceDelivery = (now.getTime() - deliveredAt.getTime()) / (1000 * 60 * 60);

      const url = new URL(request.url);
      const isTestMode = url.searchParams.get("test_mode") === "true";
      const targetOrderId = url.searchParams.get("target_order_id");

      // Filter logic
      const shouldProcess = isTestMode 
        ? (!targetOrderId || orderId.includes(targetOrderId)) // Test mode logic
        : (hoursSinceDelivery >= 24 && hoursSinceDelivery < 72); // Production logic window

      if (shouldProcess && !isVerified && !followupSent && isEnrolled) {
        if (!customerPhone) {
          console.log(`⚠️ Scaling SMS for Order ${order.name}: No phone number.`);
          continue;
        }

        console.log(`📨 Sending 24h Follow-up SMS for Order ${order.name}...`);
        
        // Use verify_url if available, or generate one
        const proofId = metafields.proof_reference;
        const link = proofId ? `https://in.ink/verify/${proofId}` : "https://in.ink";

        const message = `Haven’t verified your ${order.name} delivery yet? Tap the INK sticker or click here to access your delivery record: ${link}`;

        const success = await SMSService.sendSMS(customerPhone, message);

        if (success) {
          // Mark as sent in Shopify
          const numericCustomerId = order.id.replace("gid://shopify/Order/", "");
          const updateMutation = `#graphql
            mutation MarkFollowupSent($metafields: [MetafieldsSetInput!]!) {
              metafieldsSet(metafields: $metafields) {
                userErrors {
                  field
                  message
                }
              }
            }
          `;

          await admin.graphql(updateMutation, {
            variables: {
              metafields: [{
                ownerId: order.id,
                namespace: INK_NAMESPACE,
                key: "followup_sent",
                value: "true",
                type: "boolean"
              }]
            }
          });
          
          processedCount++;
          console.log(`✅ Order ${order.name} processed successfully.`);
        }
      }
    }

    return new Response(JSON.stringify({ 
      success: true, 
      processed: processedCount,
      message: `Processed ${processedCount} follow-up SMS messages.`
    }), {
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    console.error("❌ 24h Follow-up Job Failed:", error);
    return new Response(JSON.stringify({ error: error.message }), { status: 500 });
  }
};
