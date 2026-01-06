import type { ActionFunctionArgs } from "react-router";
import shopify, { authenticate } from "../shopify.server";

const METAFIELD_MUTATION = `
mutation SetInkMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

const TAG_MUTATION = `
mutation AddOrderTag($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors { field message }
  }
}
`;

// Query to get order line items to check for INK product
const ORDER_QUERY = `
query GetOrderLineItems($id: ID!) {
  order(id: $id) {
    lineItems(first: 50) {
      edges {
        node {
          title
          product {
            title
          }
        }
      }
    }
    customAttributes {
      key
      value
    }
  }
}
`;

// Check if an order has Premium Delivery selected
function hasPremiumDelivery(customAttributes: any[]): boolean {
  // Check for _ink_delivery_type attribute set by extensions
  for (const attr of customAttributes || []) {
    if (attr.key === "_ink_delivery_type" && attr.value === "premium") {
      return true;
    }
  }
  
  // Legacy: Also check for INK product in line items (backward compatibility)
  return false;
}

// Legacy function - kept for backward compatibility
function hasInkProduct(lineItems: any[], customAttributes: any[]): boolean {
  // Check line items for INK product
  for (const edge of lineItems || []) {
    const title = (edge.node?.title || edge.node?.product?.title || "").toLowerCase();
    if (
      title.includes("ink delivery") ||
      title.includes("ink protected") ||
      title.includes("ink premium") ||
      title.includes("premium shipping") ||
      title.includes("premium delivery")
    ) {
      return true;
    }
  }
  
  // Also check custom attributes for ink_premium_delivery
  for (const attr of customAttributes || []) {
    if (attr.key === "ink_premium_delivery" && attr.value === "true") {
      return true;
    }
    if (attr.key === "_ink_premium_fee" && attr.value === "true") {
      return true;
    }
  }
  
  return false;
}

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
  const { payload, shop, topic, session } = await authenticate.webhook(request);
  const orderGid = payload?.admin_graphql_api_id as string | undefined;
  const orderName = payload?.name || payload?.order_number || "Unknown";

  if (!orderGid || !session) {
    console.error("[orders/create] Missing order id or session", { shop, topic });
    return new Response("Missing order or session", { status: 400 });
  }

  // @ts-ignore - shopify.api.clients exists at runtime despite TypeScript error
  console.log(`\n📦 [orders/create] Processing order ${orderName} (${shop})`);

  // Check shipping lines from the webhook payload
  const shippingLines = payload?.shipping_lines || [];
  const hasPremiumDelivery = hasInkPremiumShipping(shippingLines);

  if (!hasPremiumDelivery) {
    console.log(`📦 [orders/create] Order ${orderName} has Standard Delivery - skipping INK protection`);
    return new Response("ok - standard delivery");
  }

  console.log(`🛡️ [orders/create] Order ${orderName} has INK Premium Delivery!`);

  // @ts-ignore - shopify.api.clients exists at runtime
  const client = new shopify.api.clients.Graphql({ session });

  try {
    // Add tag for easy filtering in warehouse app
    await client.request(TAG_MUTATION, {
      variables: {
        id: orderGid,
        tags: ["INK-Premium-Delivery"]
      }
    });
    
    console.log(`✅ [orders/create] Tagged order ${orderName} with "INK-Premium-Delivery"`);

    // Set initial metafields for INK Premium orders
    const variables = {
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
    };

    const result = await client.request(METAFIELD_MUTATION, { variables });
    const errors = result?.data?.metafieldsSet?.userErrors;
    
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
