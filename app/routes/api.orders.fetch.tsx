import { type LoaderFunctionArgs } from "react-router";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With, Origin",
};

// Handle OPTIONS preflight
export const action = async ({ request }: any) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: CORS_HEADERS,
    });
  }
  return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
};

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  const { getOfflineSession } = await import("../session-utils.server");

  try {
    console.log("🔍 [orders/fetch] Step 1: Request received");

    // 1. Authenticate user from JWT token
    const authHeader = request.headers.get("Authorization");
    console.log("🔍 [orders/fetch] Step 2: Auth header present:", !!authHeader, "| Starts with Bearer:", authHeader?.startsWith("Bearer "));

    if (!authHeader?.startsWith("Bearer ")) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    const token = authHeader.slice(7);
    let shopDomain = "";
    try {
      const payloadBase64 = token.split(".")[1];
      const decoded = JSON.parse(Buffer.from(payloadBase64, "base64url").toString("utf8"));
      shopDomain = decoded.shop || decoded.shop_id || decoded.merchant_id;
      console.log("🔍 [orders/fetch] Step 3: Decoded token. shopDomain:", shopDomain, "| decoded keys:", Object.keys(decoded).join(", "));
    } catch (err) {
      console.error("🔍 [orders/fetch] Step 3 FAILED: Token decode error:", err);
      return new Response(JSON.stringify({ error: "Invalid token format" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    if (!shopDomain) {
      console.error("🔍 [orders/fetch] Step 3 FAILED: shopDomain is empty/null");
      return new Response(JSON.stringify({ error: "Store context missing from token" }), {
        status: 401,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      });
    }

    if (shopDomain.startsWith("shop_")) {
      try {
        const { getDomainByShopId } = await import("../services/ink-api.server");
        const resolvedDomain = await getDomainByShopId(shopDomain);
        if (resolvedDomain) {
            console.log(`🔍 [orders/fetch] Resolved generic shop_id ${shopDomain} to Shopify domain: ${resolvedDomain}`);
            shopDomain = resolvedDomain;
        }
      } catch (e: any) {
        console.warn(`🔍 [orders/fetch] Could not resolve Shopify domain for ${shopDomain}: ${e.message}`);
      }
    }

    // 2. Get offline session for this specific store
    console.log("🔍 [orders/fetch] Step 4: Fetching offline session for:", shopDomain);
    const session = await getOfflineSession(shopDomain);
    console.log("🔍 [orders/fetch] Step 5: Session result:", session ? `Found (shop: ${session.shop}, hasToken: ${!!session.accessToken})` : "NULL - no session found");

    if (!session) {
      return new Response(
        JSON.stringify({ error: `No session available for store: ${shopDomain}` }),
        {
          status: 404,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Parse query parameters
    const url = new URL(request.url);
    const searchQuery = url.searchParams.get("search") || "";
    const mode = url.searchParams.get("mode") || "enroll"; // "enroll" (default) or "shipments"

    // Create admin client helper for Shopify API calls
    const admin = {
      graphql: async (query: string, options?: any) => {
        const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables || {},
          }),
        });

        return {
          json: async () => await response.json(),
        };
      },
    };

    console.log("📦 Fetching orders for NFC enrollment...");

    // GraphQL query to fetch orders
    const query = `
      query GetOrders {
        orders(first: 50, reverse: true) {
          edges {
            node {
              id
              name
              createdAt
              displayFinancialStatus
              displayFulfillmentStatus
              totalPriceSet {
                shopMoney {
                  amount
                  currencyCode
                }
              }
              customer {
                firstName
                lastName
                email
                phone
              }
              shippingAddress {
                address1
                address2
                city
                province
                zip
                country
                phone
              }
              tags
              metafields(namespace: "ink", first: 10) {
                edges {
                  node {
                    key
                    value
                  }
                }
              }
              shippingLines(first: 5) {
                edges {
                  node {
                    title
                    code
                  }
                }
              }
              lineItems(first: 20) {
                edges {
                  node {
                    title
                    quantity
                    variant {
                      sku
                      price
                    }
                    customAttributes {
                      key
                      value
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    console.log("🔍 [orders/fetch] Step 6: Making GraphQL call to Shopify for shop:", session.shop);
    const response = await admin.graphql(query);
    const data = await response.json();
    console.log("🔍 [orders/fetch] Step 7: GraphQL response received. Has data:", !!data?.data, "Has errors:", !!data?.errors);
    if (data?.errors) console.error("🔍 [orders/fetch] GraphQL errors:", JSON.stringify(data.errors));

    if (!data?.data?.orders) {
      console.error("❌ Failed to fetch orders:", data);
      return new Response(
        JSON.stringify({ error: "Failed to fetch orders", orders: [] }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Process orders
    const allOrders = data.data.orders.edges.map((edge: any) => {
      const order = edge.node;
      const numericId = order.id.replace("gid://shopify/Order/", "");

      // Parse metafields
      const metafields: Record<string, string> = {};
      order.metafields?.edges?.forEach((mfEdge: any) => {
        metafields[mfEdge.node.key] = mfEdge.node.value;
      });

      // Check if order has INK Premium Delivery
      const hasInkTag = order.tags?.includes("INK-Premium-Delivery") || order.tags?.includes("INK-Verified-Delivery");
      const hasDeliveryTypeMetafield = metafields.delivery_type === "premium";
      const hasInkMetafield = metafields.ink_premium_order === "true";

      // Check line items for INK products
      let hasInkLineItem = false;
      for (const lineItem of order.lineItems?.edges || []) {
        const title = (lineItem.node?.title || "").toLowerCase();
        if (
          title.includes("ink delivery") || 
          title.includes("ink protected") || 
          title.includes("ink premium") ||
          title.includes("ink verified") ||
          title.includes("verified delivery")
        ) {
          hasInkLineItem = true;
          break;
        }
        for (const attr of lineItem.node?.customAttributes || []) {
          if (attr.key === "_ink_premium_fee" && attr.value === "true") {
            hasInkLineItem = true;
            break;
          }
        }
      }

      // Check shipping method
      let hasInkShippingMethod = false;
      const shippingMethod = order.shippingLines?.edges?.[0]?.node?.title || "";
      if (shippingMethod.toLowerCase().includes("ink")) {
        hasInkShippingMethod = true;
      }

      const isInkOrder = hasInkTag || hasDeliveryTypeMetafield || hasInkMetafield || hasInkLineItem || hasInkShippingMethod;

      // Filter by isInkOrder so that plain orders (like #1007) are hidden
      // We no longer ignore it.


      // Get verification status from INK metafield (or fallback to pending)
      const verificationStatus = (metafields.verification_status || "pending").toLowerCase();

      // Eligibility logic depends on mode:
      // - "shipments" mode: show orders that ARE enrolled/verified/delivered (for shipment tracking)
      // - "enroll" mode: show orders that are NOT yet enrolled/verified (for the scan queue)
      let isEligible: boolean;
      if (mode === "shipments") {
        isEligible = isInkOrder && (verificationStatus === "enrolled" || verificationStatus === "verified" || verificationStatus === "delivered");
      } else {
        // enroll mode: show everything that isn't done yet
        isEligible = isInkOrder && verificationStatus !== "enrolled" && verificationStatus !== "verified" && verificationStatus !== "delivered";
      }

      // Get line item details (now includes sku and price from variant)
      const items = order.lineItems?.edges?.map((li: any) => ({
        title: li.node.title,
        quantity: li.node.quantity,
        sku: li.node.variant?.sku || "",
        price: parseFloat(li.node.variant?.price || "0"),
      })) || [];

      // Determine shipping status
      let shippingStatus = "STANDARD";
      let shippingColor = "gray";
      
      const fulfillmentStatus = order.displayFulfillmentStatus || "";
      if (fulfillmentStatus.includes("Unfulfilled") || fulfillmentStatus === "") {
        const createdAt = new Date(order.createdAt);
        const now = new Date();
        const hoursOld = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60);
        
        if (hoursOld < 24) {
          shippingStatus = "SHIPS TODAY — 2H REMAINING";
          shippingColor = "red";
        } else if (hoursOld < 48) {
          shippingStatus = "SHIPS TOMORROW";
          shippingColor = "orange";
        }
      }

      // Build a normalized ShippingAddress object
      const shippingAddress = order.shippingAddress ? {
        line1: order.shippingAddress.address1 || "",
        line2: order.shippingAddress.address2 || "",
        city: order.shippingAddress.city || "",
        state: order.shippingAddress.province || "",
        zip: order.shippingAddress.zip || "",
        country: order.shippingAddress.country || "",
        phone: order.shippingAddress.phone || "",
      } : null;

      return {
        id: numericId,
        name: order.name,
        // Derive sequential order number from name ("#1019" → 1019)
        orderNumber: order.name ? parseInt(order.name.replace(/^#/, ""), 10) || undefined : undefined,
        createdAt: order.createdAt,
        items,
        itemCount: items.reduce((sum: number, item: any) => sum + item.quantity, 0),
        totalPrice: parseFloat(order.totalPriceSet.shopMoney.amount).toFixed(2),
        currency: order.totalPriceSet.shopMoney.currencyCode,
        currencySymbol: order.totalPriceSet.shopMoney.currencyCode === "USD" ? "$" : order.totalPriceSet.shopMoney.currencyCode,
        shippingStatus,
        shippingColor,
        customerName: order.customer
          ? `${order.customer.firstName} ${order.customer.lastName}`
          : "Guest",
        customerEmail: order.customer?.email || "",
        customerPhone: order.customer?.phone || order.shippingAddress?.phone || "",
        shippingAddress,
        verificationStatus,
        isEligible,
      };
    });

    // Filter to only eligible orders
    let eligibleOrders = allOrders.filter((order: any) => order.isEligible);

    // Apply search filter if provided
    if (searchQuery) {
      eligibleOrders = eligibleOrders.filter((order: any) => 
        order.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        order.id.includes(searchQuery) ||
        order.items.some((item: any) => item.title.toLowerCase().includes(searchQuery.toLowerCase()))
      );
    }

    console.log(`✅ Found ${eligibleOrders.length} eligible orders (${allOrders.length} total)`);



    return new Response(
      JSON.stringify({ 
        success: true,
        orders: eligibleOrders,
        total: eligibleOrders.length 
      }),
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );

  } catch (error: any) {
    console.error("❌ [orders/fetch] UNHANDLED ERROR:", error?.message);
    console.error("❌ [orders/fetch] STACK:", error?.stack);

    return new Response(
      JSON.stringify({ 
        error: error.message || "Failed to fetch orders",
        orders: [] 
      }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );
  }
};
