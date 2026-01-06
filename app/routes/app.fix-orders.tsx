import { authenticate } from "../shopify.server";
import type { ActionFunctionArgs } from "react-router";

/**
 * Manual action to check and tag orders with INK Premium Delivery
 * This checks the shipping method and adds tags if missing
 */
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  console.log("🔍 Checking recent orders for INK Premium Delivery...");

  const query = `
    query {
      orders(first: 10, reverse: true) {
        edges {
          node {
            id
            name
            tags
            shippingLine {
              title
            }
          }
        }
      }
    }
  `;

  const response = await admin.graphql(query);
  const data = await response.json();

  const results: any[] = [];

  for (const edge of data.data.orders.edges) {
    const order = edge.node;
    const shippingTitle = order.shippingLine?.title || "";
    
    const hasInkShipping = 
      shippingTitle.toLowerCase().includes("ink premium") ||
      shippingTitle.toLowerCase().includes("ink delivery");
    
    const hasTag = order.tags?.includes("INK-Premium-Delivery");

    results.push({
      order: order.name,
      shipping: shippingTitle,
      hasInkShipping,
      hasTag,
      needsTag: hasInkShipping && !hasTag
    });

    // If needs tag, add it
    if (hasInkShipping && !hasTag) {
      console.log(`📌 Adding tag to ${order.name}...`);
      
      const TAG_MUTATION = `
        mutation AddOrderTag($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }
      `;

      await admin.graphql(TAG_MUTATION, {
        variables: {
          id: order.id,
          tags: ["INK-Premium-Delivery"]
        }
      });

      const METAFIELD_MUTATION = `
        mutation SetInkMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `;

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

      console.log(`✅ Tagged ${order.name}`);
    }
  }

  return new Response(JSON.stringify({ results }, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
