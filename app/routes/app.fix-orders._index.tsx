import { authenticate } from "../shopify.server";
import type { LoaderFunctionArgs } from "react-router";
import { Form } from "react-router";

/**
 * Admin page to fix orders - check and tag all INK Premium Delivery orders
 */
export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);
  return null;
}

export default function FixOrders() {
  return (
    <s-page>
      <s-section heading="Fix INK Premium Delivery Orders">
        <p>This will check all recent orders and automatically tag any orders with "INK Premium Delivery" shipping method.</p>
        
        <Form method="post" action="/app/fix-orders">
          <button
            type="submit"
            style={{
              padding: "12px 24px",
              background: "#008060",
              color: "white",
              border: "none",
              borderRadius: "4px",
              fontSize: "16px",
              cursor: "pointer",
              marginTop: "16px"
            }}
          >
            Check & Tag Orders
          </button>
        </Form>

        <div style={{marginTop: "24px", padding: "16px", background: "#f6f6f7", borderRadius: "8px"}}>
          <h3>What this does:</h3>
          <ul>
            <li>Checks last 10 orders</li>
            <li>Finds orders with "INK Premium Delivery" shipping</li>
            <li>Adds tag: <code>INK-Premium-Delivery</code></li>
            <li>Adds metafields for tracking</li>
            <li>Orders will appear in dashboard</li>
          </ul>
        </div>
      </s-section>
    </s-page>
  );
}
