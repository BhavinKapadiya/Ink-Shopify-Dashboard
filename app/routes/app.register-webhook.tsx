import { authenticate } from "../shopify.server";
import type { ActionFunctionArgs } from "react-router";

/**
 * Manually register the orders/create webhook
 */
export async function action({ request }: ActionFunctionArgs) {
  const { admin } = await authenticate.admin(request);

  console.log("📝 Registering orders/create webhook...");

  const WEBHOOK_SUBSCRIPTION_CREATE = `
    mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
      webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
        webhookSubscription {
          id
          topic
          endpoint {
            __typename
            ... on WebhookHttpEndpoint {
              callbackUrl
            }
          }
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const response = await admin.graphql(WEBHOOK_SUBSCRIPTION_CREATE, {
    variables: {
      topic: "ORDERS_CREATE",
      webhookSubscription: {
        callbackUrl: "https://shopify-app-250065525755.us-central1.run.app/webhooks/orders/create",
        format: "JSON",
      },
    },
  });

  const data = await response.json();

  console.log("Webhook registration result:", JSON.stringify(data, null, 2));

  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json" },
  });
}
