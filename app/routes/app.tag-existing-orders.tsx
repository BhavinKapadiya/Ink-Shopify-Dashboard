import { authenticate } from "../shopify.server";

/**
 * Manual script to tag existing orders with INK Premium Delivery shipping method
 * Run this once to fix orders created before the webhook was updated
 */

const TAG_MUTATION = `
mutation AddOrderTag($id: ID!, $tags: [String!]!) {
  tagsAdd(id: $id, tags: $tags) {
    userErrors { field message }
  }
}
`;

const METAFIELD_MUTATION = `
mutation SetInkMetafields($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

export async function action({ request }: any) {
  const { admin } = await authenticate.admin(request);

  console.log("🔍 Searching for orders with INK Premium Delivery shipping method...");

  // Query recent orders
  const query = `
    query {
      orders(first: 50, reverse: true, query: "fulfillment_status:unfulfilled OR fulfillment_status:fulfilled") {
        edges {
          node {
            id
            name
            tags
            shippingLine {
              title
            }
            metafields(namespace: "ink", first: 5) {
              edges {
                node {
                  key
                  value
                }
              }
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const data = await response.json();

  let taggedCount = 0;

  for (const edge of data.data.orders.edges) {
    const order = edge.node;
    const shippingTitle = (order.shippingLine?.title || "").toLowerCase();

    // Check if this order has INK Premium Delivery
    if (
      shippingTitle.includes("ink premium") ||
      shippingTitle.includes("ink delivery")
    ) {
      // Check if already tagged
      const hasTag = order.tags?.includes("INK-Premium-Delivery");

      if (!hasTag) {
        console.log(`📦 Found order ${order.name} with INK Premium Delivery - adding tag...`);

        // Add tag
        await admin.graphql(TAG_MUTATION, {
          variables: {
            id: order.id,
            tags: ["INK-Premium-Delivery"],
          },
        });

        // Add metafields
        await admin.graphql(METAFIELD_MUTATION, {
          variables: {
            metafields: [
              {
                ownerId: order.id,
                namespace: "ink",
                key: "delivery_type",
                type: "single_line_text_field",
                value: "premium",
              },
              {
                ownerId: order.id,
                namespace: "ink",
                key: "verification_status",
                type: "single_line_text_field",
                value: "pending",
              },
            ],
          },
        });

        console.log(`✅ Tagged order ${order.name}`);
        taggedCount++;
      } else {
        console.log(`⏭️  Order ${order.name} already tagged`);
      }
    }
  }

  return new Response(
    JSON.stringify({
      success: true,
      message: `Tagged ${taggedCount} orders`,
      taggedCount,
    }),
    {
      headers: { "Content-Type": "application/json" },
    }
  );
}
