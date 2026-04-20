import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { NotificationService } from "../services/notifications.server";
import firestore from "../firestore.server";

export const action = async ({ request }: ActionFunctionArgs) => {
  console.log("\n📦 ================================================");
  console.log("📦 WEBHOOK RECEIVED: FULFILLMENTS_CREATE");

  try {
    const { payload, shop, topic, admin } = await authenticate.webhook(request);

    // admin can be undefined for webhooks that don't carry an admin context
    if (!admin) {
      console.log(`📦 No admin context available for this webhook delivery. Exiting.`);
      console.log("📦 ================================================\n");
      return new Response("OK", { status: 200 });
    }

    const fulfillment = payload as any;
    let shipmentStatus = fulfillment.shipment_status;
    const orderId = fulfillment.order_id;
    const orderGid = `gid://shopify/Order/${orderId}`;

    // DEV HACK: Force delivered if tracking number is literally exactly '1'
    if (fulfillment.tracking_number === "1" || fulfillment.tracking_numbers?.includes("1") || fulfillment.tracking_company === "Other") {
      if (fulfillment.tracking_number === "1" || fulfillment.tracking_numbers?.includes("1")) {
         console.log(`🧑‍💻 DEV HACK: Tracking number '1' detected! Force-spoofing shipment state to 'delivered'.`);
         shipmentStatus = "delivered";
      }
    }

    console.log(`📦 Store: ${shop}`);
    console.log(`📦 Order ID: ${orderId}`);
    console.log(`📦 Shipment Status: ${shipmentStatus || "None/Unknown"}`);

    // If it's not one of our targeted statuses, we ignore it.
    if (shipmentStatus !== "out_for_delivery" && shipmentStatus !== "delivered") {
      console.log(`📦 Status is not actionable for notifications. Exiting.`);
      console.log("📦 ================================================\n");
      return new Response("OK", { status: 200 });
    }

    // 1. Fetch the Order to check if it's an INK order and get customer info
    const orderQuery = `#graphql
      query GetOrderForFulfillmentEvent($id: ID!) {
        order(id: $id) {
          name
          email
          phone
          shippingAddress {
            phone
          }
          customer {
            email
            phone
            firstName
          }
          proofMetafield: metafield(namespace: "ink", key: "proof_reference") { value }
          ledgerMetafield: metafield(namespace: "ink", key: "notification_ledger") { value }
        }
      }
    `;

    console.log(`📦 Querying Shopify for Order details...`);
    const orderData = await admin.graphql(orderQuery, { variables: { id: orderGid } });
    const orderJson = await orderData.json();
    const order = orderJson.data?.order;

    if (!order) {
      console.log(`❌ Order not found in Shopify. Exiting.`);
      return new Response("OK", { status: 200 });
    }

    // Is it an INK order?
    if (!order.proofMetafield || !order.proofMetafield.value) {
      console.log(`ℹ️ Order ${order.name} is not Enrolled with a Proof Reference. Skipping.`);
      return new Response("OK", { status: 200 });
    }

    const ledgerValue = order.ledgerMetafield?.value;
    const ledger = ledgerValue ? JSON.parse(ledgerValue) : {};

    // 2. Fetch Merchant Notification Settings from Firestore
    console.log(`📦 Fetching Merchant Settings for ${shop}...`);
    const settingsSnap = await firestore.collection("merchants").where("shopDomain", "==", shop).limit(1).get();
    
    if (settingsSnap.empty) {
      console.log(`⚠️ No merchant document found for ${shop}. Exiting.`);
      return new Response("OK", { status: 200 });
    }

    const settings = settingsSnap.docs[0].data().notification_settings;
    const merchantName = settingsSnap.docs[0].data().shopName || shop;

    if (!settings) {
      console.log(`⚠️ Merchant has no Notification Settings configured. Exiting.`);
      return new Response("OK", { status: 200 });
    }

    // 3. Map to our NotificationType
    let notificationType: "outForDelivery" | "delivered" | null = null;
    if (shipmentStatus === "out_for_delivery") notificationType = "outForDelivery";
    if (shipmentStatus === "delivered") notificationType = "delivered";

    if (notificationType) {
      if (ledger[notificationType]) {
        console.log(`ℹ️ [${notificationType}] was already sent to ${order.name}. Skipping duplicate.`);
        return new Response("OK", { status: 200 });
      }

      // Natively stamp delivered_at to Shopify if delivered
      if (notificationType === "delivered") {
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
        console.log(`✅ Stamped ink.delivered_at natively to Shopify for Cron Job math.`);
      }

      const customerEmail = order.email || order.customer?.email;
      const customerPhone = order.shippingAddress?.phone || order.phone || order.customer?.phone;
      const customerName = order.customer?.firstName || "Customer";
      const verifyUrl = undefined;

      console.log(`\n📨 Dispatching immediate [${notificationType}] notification via NotificationService...`);
      console.log(`   - To: ${customerName}`);
      console.log(`   - Phone: ${customerPhone}`);
      
      const sent = await NotificationService.dispatch({
        type: notificationType,
        toEmail: customerEmail,
        toPhone: customerPhone,
        customerName: customerName,
        orderName: order.name,
        merchantName: merchantName,
        verifyUrl: verifyUrl,
      }, settings);

      if (sent) {
        console.log(`✅ Successfully dispatched ${notificationType} notification.`);
        
        // Update Ledger to prevent duplicate webhook sends
        ledger[notificationType] = new Date().toISOString();
        const mutation = `#graphql
          mutation UpdateLedger($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) { userErrors { message } }
          }
        `;
        const INK_NAMESPACE = "ink";
        await admin.graphql(mutation, {
          variables: {
            metafields: [{
              ownerId: orderGid,
              namespace: INK_NAMESPACE,
              key: "notification_ledger",
              type: "json",
              value: JSON.stringify(ledger)
            }]
          }
        });
        console.log(`✅ Notification ledger updated on Shopify.`);
      } else {
        console.log(`ℹ️ Notification skipped or failed (perhaps channel disabled).`);
      }
    }

  } catch (error: any) {
    console.error("❌ Error processing FULFILLMENTS_CREATE webhook:", error.message);
  }

  console.log("📦 Webhook processing complete.");
  console.log("📦 ================================================\n");
  
  return new Response("OK", { status: 200 });
};
