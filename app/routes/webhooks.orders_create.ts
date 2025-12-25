import type { ActionFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";

const METAFIELD_MUTATION = `
mutation SetInkMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
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

// Check if an order contains INK Protected Delivery product
function hasInkProduct(lineItems: any[], customAttributes: any[]): boolean {
  // Check line items for INK product
  for (const edge of lineItems || []) {
    const title = (edge.node?.title || edge.node?.product?.title || "").toLowerCase();
    if (
      title.includes("ink protected delivery") ||
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

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, admin } = await authenticate.webhook(request);
  const orderGid = payload?.admin_graphql_api_id as string | undefined;

  if (!orderGid || !admin) {
    console.error("[orders/create] Missing order id or admin", { shop, topic });
    return new Response("Missing order or admin", { status: 400 });
  }

  // First, query the order to check if it has INK product
  try {
    const orderResponse = await admin.graphql(ORDER_QUERY, {
      variables: { id: orderGid }
    });
    const orderResult = await orderResponse.json();
    
    const orderData = orderResult?.data?.order;
    const lineItems = orderData?.lineItems?.edges || [];
    const customAttributes = orderData?.customAttributes || [];
    
    const isInkOrder = hasInkProduct(lineItems, customAttributes);
    
    if (!isInkOrder) {
      console.log(`[orders/create] Not an INK order, skipping metafields for ${shop} -> ${orderGid}`);
      return new Response("ok - not an INK order");
    }
    
    console.log(`[orders/create] INK order detected for ${shop} -> ${orderGid}`);
  } catch (error) {
    console.error("[orders/create] Error querying order:", error);
    // Continue anyway to set metafields in case of query error
  }

  // Set metafields for INK orders
  const metafieldMutation = await admin.graphql(METAFIELD_MUTATION, {
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
          key: "proof_reference",
          type: "single_line_text_field",
          value: String(payload?.id ?? ""),
        },
        {
          ownerId: orderGid,
          namespace: "ink",
          key: "photos_hashes",
          type: "single_line_text_field",
          value: "[]",
        },
        {
          ownerId: orderGid,
          namespace: "ink",
          key: "nfc_uid",
          type: "single_line_text_field",
          value: "",
        },
        {
          ownerId: orderGid,
          namespace: "ink",
          key: "ink_premium_order",
          type: "single_line_text_field",
          value: "true",
        },
      ],
    },
  });
  
  const result = await metafieldMutation.json();
  const errors = result?.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    console.error("[orders/create] Metafield errors", errors);
    return new Response("Metafield error", { status: 500 });
  }

  console.log(`[orders/create] INK metafields initialized for ${shop} -> ${orderGid}`);
  return new Response("ok");
};
