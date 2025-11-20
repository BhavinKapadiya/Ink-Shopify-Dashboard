import type { ActionFunctionArgs } from "react-router";
import shopify, { authenticate } from "../shopify.server";

const METAFIELD_MUTATION = `
mutation SetFulfillmentStatus($metafields: [MetafieldsSetInput!]!) {
  metafieldsSet(metafields: $metafields) {
    userErrors { field message }
  }
}
`;

export const action = async ({ request }: ActionFunctionArgs) => {
  const { payload, shop, topic, session } = await authenticate.webhook(request);

  const orderGid =
    (payload?.order?.admin_graphql_api_id as string | undefined) ||
    (payload?.order_id ? `gid://shopify/Order/${payload.order_id}` : undefined);

  if (!orderGid || !session) {
    console.error("[fulfillments/*] Missing order id or session", { shop, topic });
    return new Response("Missing order or session", { status: 400 });
  }

  const statusValue = topic.includes("update") ? "in_fulfillment" : "fulfillment_created";

  const client = new shopify.api.clients.Graphql({ session });
  const variables = {
    metafields: [
      {
        ownerId: orderGid,
        namespace: "ink",
        key: "verification_status",
        type: "single_line_text_field",
        value: statusValue,
      },
    ],
  };

  const result = await client.request(METAFIELD_MUTATION, { variables });
  const errors = result?.data?.metafieldsSet?.userErrors;
  if (errors?.length) {
    console.error("[fulfillments/*] Metafield errors", errors);
    return new Response("Metafield error", { status: 500 });
  }

  console.log(`[${topic}] Metafields updated for ${shop} -> ${orderGid}`);
  return new Response("ok");
};
