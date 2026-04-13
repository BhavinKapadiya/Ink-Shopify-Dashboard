import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import firestore from "../firestore.server";
import crypto from "crypto";

/**
 * Public endpoint (authenticated by warehouse JWT only).
 * Proxies enrollment requests to the INK API using the merchant's stored api_key.
 * 
 * POST /app/api/warehouse/enroll
 * Body (JSON): { orderId, nfcToken, nfcUid?, shippingAddress?, warehouseLat?, warehouseLng?, orderDetails? }
 *
 * Response: { proof_id, nfcToken, state, enrolled_at }
 */

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
    ...init,
  });

const INK_API_URL =
  process.env.INK_API_URL ||
  process.env.NFS_API_URL ||
  "https://us-central1-inink-c76d3.cloudfunctions.net/api";

const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

function extractTokenPayload(token: string): { shop?: string; merchant_id?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;

    // 1. Try strict HMAC verification (our own issued tokens)
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");

    let payload: any;
    if (signature === expectedSig) {
      payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
      if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
      return { shop: payload.shop, merchant_id: payload.merchant_id };
    }

    // 2. Fall back to decode-without-verify (Alan's JWTs)
    payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return { shop: payload.shop, merchant_id: payload.merchant_id };
  } catch {
    return null;
  }
}

import { createMerchant, enrollOrder, getShopIdByDomain, adjustMerchantInventory, getInventoryByShopDomain } from "../services/ink-api.server";

async function getMerchantApiKey(shopDomain?: string, merchantId?: string): Promise<string | null> {
  // 1. Try matching by Firestore document ID (=== merchant_id from Alan JWT)
  if (merchantId) {
    const doc = await firestore.collection("merchants").doc(merchantId).get();
    if (doc.exists) {
      const apiKey = doc.data()?.ink_api_key;
      if (apiKey && apiKey !== "sk_test_fallback") return apiKey;
    }
  }

  // 2. Try matching by shopDomain field
  if (shopDomain) {
    const snapshot = await firestore
      .collection("merchants")
      .where("shopDomain", "==", shopDomain)
      .limit(1)
      .get();

    if (!snapshot.empty) {
      const data = snapshot.docs[0].data();
      const apiKey = data?.ink_api_key;
      if (apiKey && apiKey !== "sk_test_fallback") return apiKey;
    }
  }

  // 3. Auto-provision merchant if neither lookup worked
  const identifier = shopDomain || merchantId;
  if (identifier) {
    console.log(`[Warehouse Enroll] Key not found for ${identifier}. Auto-provisioning...`);
    try {
      const inkRes = await createMerchant(identifier, identifier, `admin@${identifier}`);
      const apiKey = inkRes.api_key;
      // CRITICAL: Use doc(identifier) with set() so the document has a predictable ID.
      // Using .add() creates a random ID that can never be found by the next request.
      const docId = merchantId || identifier;
      await firestore.collection("merchants").doc(docId).set({
        shopDomain: identifier,
        ink_api_key: apiKey,
        createdAt: new Date(),
        updatedAt: new Date(),
      }, { merge: true });
      console.log(`[Warehouse Enroll] ✅ Provisioned and saved under merchants/${docId}`);
      return apiKey;
    } catch (e: any) {
      console.error("[Warehouse Enroll] Auto-provision failed:", e.message);
    }
  }

  return null;
}

// CORS preflight
export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  // 1. Verify JWT (HMAC or Alan)
  const authHeader = request.headers.get("Authorization");
  console.log("\n══════════════════════════════════════════");
  console.log("[ENROLL] Incoming request from:", request.headers.get("origin") || "unknown origin");
  console.log("[ENROLL] Auth header present:", !!authHeader);
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[ENROLL] ❌ Missing or malformed Authorization header");
    return json({ error: "Unauthorized" }, { status: 401 });
  }
  const tokenPayload = extractTokenPayload(authHeader.slice(7));
  console.log("[ENROLL] Token payload decoded:", tokenPayload ? JSON.stringify(tokenPayload) : "NULL (invalid/expired)");
  if (!tokenPayload) {
    console.log("[ENROLL] ❌ Token rejected");
    return json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const { shop: shopDomain, merchant_id: merchantId } = tokenPayload;
  console.log("[ENROLL] shopDomain:", shopDomain, "| merchantId:", merchantId);

  // 2. Get merchant's INK api_key
  console.log("[ENROLL] Looking up ink_api_key in Firestore...");
  const apiKey = await getMerchantApiKey(shopDomain, merchantId);
  if (!apiKey) {
    console.log("[ENROLL] ❌ No ink_api_key found for merchant");
    return json({ error: "Merchant not found or not linked to INK" }, { status: 404 });
  }
  console.log("[ENROLL] ✅ ink_api_key found, prefix:", apiKey.slice(0, 12) + "...");

  // 3. Parse request body
  let body: any;
  try {
    body = await request.json();
    console.log("[ENROLL] Request body keys:", Object.keys(body));
  } catch {
    console.log("[ENROLL] ❌ Failed to parse request body as JSON");
    return json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { 
    order_id, 
    nfc_token, 
    nfc_uid, 
    order_number, 
    customer_email, 
    customer_phone,
    shipping_address, 
    product_details, 
    warehouse_location,
    photo_urls,
    photo_hashes,
    carrier_name: frontend_carrier_name,
    tracking_number: frontend_tracking_number
  } = body;

  if (!order_id || !nfc_token || !order_number || !customer_email || !shipping_address || !product_details) {
    console.log("[ENROLL] ❌ Missing required fields. Present:", { order_id: !!order_id, nfc_token: !!nfc_token, order_number: !!order_number, customer_email: !!customer_email, shipping_address: !!shipping_address, product_details: !!product_details });
    return json({ error: "order_id, nfc_token, order_number, customer_email, shipping_address, and product_details are required" }, { status: 400 });
  }

  // 3b. Inventory & min_enrollment_value gate (M4)
  const effectiveIdentifier = shopDomain || merchantId;
  if (effectiveIdentifier) {
    try {
      // Check live inventory count
      const inventoryData = await getInventoryByShopDomain(effectiveIdentifier);
      const currentCount = inventoryData?.current_count ?? 0;
      if (currentCount <= 0) {
        console.log("[ENROLL] ❌ Enrollment blocked: inventory is zero or negative:", currentCount);
        return json(
          { error: "Insufficient sticker inventory. Please reorder at shop.in.ink before enrolling new packages." },
          { status: 400 }
        );
      }
      console.log("[ENROLL] ✅ Inventory check passed. Current count:", currentCount);

      // Check min_enrollment_value setting
      const merchantDoc = await (async () => {
        const doc = await firestore.collection("merchants").doc(effectiveIdentifier).get();
        if (doc.exists) return doc.data();
        const snap = await firestore.collection("merchants").where("shopDomain", "==", effectiveIdentifier).limit(1).get();
        return snap.empty ? null : snap.docs[0].data();
      })();

      const minValue = merchantDoc?.min_enrollment_value ?? 0;
      if (minValue > 0) {
        // order_total_value is passed in body from the PWA
        const orderTotal = parseFloat(body.order_total_value ?? "0") || 0;
        if (orderTotal < minValue) {
          console.log(`[ENROLL] ❌ Enrollment blocked: order total $${orderTotal} < min_enrollment_value $${minValue}`);
          return json(
            { error: `Order value $${orderTotal.toFixed(2)} is below the minimum enrollment value of $${minValue.toFixed(2)}.` },
            { status: 400 }
          );
        }
        console.log(`[ENROLL] ✅ Min value check passed. Order: $${orderTotal}, Min: $${minValue}`);
      }
    } catch (gateErr: any) {
      // Non-fatal: if the gate check fails, log and continue to avoid blocking legitimate enrollments
      console.warn("[ENROLL] ⚠️ Gate check error (non-fatal):", gateErr.message);
    }
  }

  console.log("[ENROLL] product_details count:", Array.isArray(product_details) ? product_details.length : "NOT array");
  console.log("[ENROLL] warehouse_location:", warehouse_location);

  // 4. Build enrollment payload and fetch tracking info from Shopify
  let carrier_name: string | null = frontend_carrier_name || null;
  let tracking_number: string | null = frontend_tracking_number || null;
  const numericOrderId = order_id.replace(/\D/g, "");
  let foundOrderGid = `gid://shopify/Order/${numericOrderId}`;

  const effectiveShopDomain = shopDomain || merchantId;
  if (effectiveShopDomain) {
    try {
      const { getOfflineSession } = await import("../session-utils.server");
      const session = await getOfflineSession(effectiveShopDomain);
      if (session) {
        const adminGraphql = async (query: string, variables?: any) => {
          const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Shopify-Access-Token": session.accessToken,
            },
            body: JSON.stringify({ query, variables }),
          });
          return response.json();
        };

        const idQuery = `#graphql
          query getOrderById($id: ID!) {
            order(id: $id) {
              id
              fulfillments {
                trackingInfo {
                  company
                  number
                }
              }
            }
          }
        `;

        let orderNode = null;
        const potentialGid = `gid://shopify/Order/${numericOrderId}`;
        const idResult = await adminGraphql(idQuery, { id: potentialGid });
        
        if (idResult?.data?.order) {
          orderNode = idResult.data.order;
        } else {
          console.log(`[ENROLL] Direct ID lookup failed for ${potentialGid}. Trying name search...`);
          const nameQuery = `#graphql
            query FindOrderByName($query: String!) {
              orders(first: 1, query: $query) {
                edges { node { id fulfillments { trackingInfo { company number } } } }
              }
            }
          `;
          const searchResult = await adminGraphql(nameQuery, { query: `name:${numericOrderId}` });
          if (searchResult?.data?.orders?.edges?.length > 0) {
            orderNode = searchResult.data.orders.edges[0].node;
          } else {
            const searchResult2 = await adminGraphql(nameQuery, { query: `name:#${numericOrderId}` });
            if (searchResult2?.data?.orders?.edges?.length > 0) {
              orderNode = searchResult2.data.orders.edges[0].node;
            }
          }
        }

        if (orderNode) {
          foundOrderGid = orderNode.id;
          const fulfillments = orderNode.fulfillments || [];
          console.log(`[ENROLL] Raw Fulfillments from Shopify API:`, JSON.stringify(fulfillments, null, 2));
          for (const fulfillment of fulfillments) {
            const trackingInfo = fulfillment?.trackingInfo;
            if (trackingInfo && trackingInfo.length > 0) {
              carrier_name = trackingInfo[0]?.company || null;
              tracking_number = trackingInfo[0]?.number || null;
              if (carrier_name || tracking_number) break;
            }
          }
        }
      }
    } catch (err) {
      console.warn("[Warehouse Enroll] Failed to fetch tracking info from Shopify:", err);
    }
  }

  console.log(`[ENROLL] Extracted Carrier: ${carrier_name}, Tracking: ${tracking_number}`);

  // 5. Call INK API enroll endpoint using the shared service
  let inkData;
  try {
    console.log("[ENROLL] → Calling Alan's /api/enroll...");
    const enrollStart = Date.now();
    inkData = await enrollOrder(
      apiKey, 
      numericOrderId, 
      nfc_token, 
      String(order_number), 
      customer_email,
      shipping_address,
      Array.isArray(product_details) ? product_details : [],
      warehouse_location && warehouse_location.lat ? { lat: warehouse_location.lat, lng: warehouse_location.lng } : undefined,
      nfc_uid,
      photo_urls,
      photo_hashes,
      carrier_name,
      tracking_number,
      customer_phone
    );
    console.log(`[ENROLL] ✅ Alan enroll responded in ${Date.now() - enrollStart}ms`);
    console.log("[ENROLL] Alan response:", JSON.stringify(inkData));
  } catch (error: any) {
    console.error("[ENROLL] ❌ Alan enroll failed:", error.message);

    // If Allan's API rejects the key (401), try to auto-heal by provisioning a fresh one.
    if (error.message.includes("401") || error.message.includes("Unauthorized") || error.message.includes("Invalid API key")) {
      const identifier = shopDomain || merchantId || "";
      console.log(`[Warehouse Enroll] INK rejected key for ${identifier}. Auto-healing with fresh key...`);
      try {
        const inkMerchantRes = await createMerchant(identifier, identifier, `admin@${identifier}`);
        const freshApiKey = inkMerchantRes.api_key;

        if (freshApiKey) {
          // Update Firestore with the fresh key
          if (merchantId) {
            const doc = await firestore.collection("merchants").doc(merchantId).get();
            if (doc.exists) {
              await doc.ref.update({ ink_api_key: freshApiKey, updatedAt: new Date() });
            } else {
              await firestore.collection("merchants").doc(merchantId).set({
                shopDomain: identifier,
                ink_api_key: freshApiKey,
                createdAt: new Date(),
                updatedAt: new Date(),
              });
            }
          } else if (shopDomain) {
            const merchantDocs = await firestore.collection("merchants").where("shopDomain", "==", shopDomain).limit(1).get();
            if (!merchantDocs.empty) {
              await merchantDocs.docs[0].ref.update({ ink_api_key: freshApiKey, updatedAt: new Date() });
            }
          }

          // Retry enrollment with fresh key
          inkData = await enrollOrder(
            freshApiKey, numericOrderId, nfc_token, String(order_number),
            customer_email, shipping_address,
            Array.isArray(product_details) ? product_details : [],
            warehouse_location?.lat ? warehouse_location : undefined,
            nfc_uid, photo_urls, photo_hashes, carrier_name, tracking_number, customer_phone
          );
        } else {
          return json({ error: "Could not provision merchant API key. Contact support." }, { status: 500 });
        }
      } catch (healErr: any) {
        console.error("[Warehouse Enroll] Self-heal failed:", healErr.message);
        return json({ error: "Enrollment failed. Please log out and log in again, then retry." }, { status: 401 });
      }
    } else {
      return json({ error: error.message || "Enrollment failed" }, { status: 500 });
    }
  }

  // 6. Update Shopify Metafields
  if (effectiveShopDomain) {
  try {
    const { getOfflineSession } = await import("../session-utils.server");
    console.log(`[ENROLL] Looking up Shopify session for ${effectiveShopDomain}...`);
    const session = await getOfflineSession(effectiveShopDomain);
    
    if (session) {
        const adminGraphql = async (query: string, variables?: any) => {
            const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "X-Shopify-Access-Token": session.accessToken,
                },
                body: JSON.stringify({ query, variables }),
            });
            return response.json();
        };

        const metafields = [
            {
                ownerId: foundOrderGid,
                namespace: "ink",
                key: "verification_status",
                type: "single_line_text_field",
                value: "enrolled",
            },
            {
                ownerId: foundOrderGid,
                namespace: "ink",
                key: "nfc_uid",
                type: "single_line_text_field",
                value: nfc_uid || nfc_token,
            },
            {
                ownerId: foundOrderGid,
                namespace: "ink",
                key: "proof_reference",
                type: "single_line_text_field",
                value: inkData.proof_id,
            },
            // Store the nfc_token separately so the retrieve endpoint can
            // query Alan's GET /api/proofs/{nfc_token} without a Firestore lookup.
            {
                ownerId: foundOrderGid,
                namespace: "ink",
                key: "ink_token",
                type: "single_line_text_field",
                value: nfc_token,
            }
        ];

        if (warehouse_location && warehouse_location.lat && warehouse_location.lng) {
            metafields.push({
                ownerId: foundOrderGid,
                namespace: "ink",
                key: "warehouse_gps",
                type: "json",
                value: JSON.stringify({ lat: warehouse_location.lat, lng: warehouse_location.lng }),
            });
        }

        const mutation = `
            mutation SetEnrollmentMetafields($metafields: [MetafieldsSetInput!]!) {
                metafieldsSet(metafields: $metafields) {
                    userErrors { field message }
                }
            }
        `;
        
        const mResp = await adminGraphql(mutation, { metafields });
        if (mResp.data?.metafieldsSet?.userErrors?.length > 0) {
            console.error("[Warehouse Enroll] Metafield update errors:", mResp.data.metafieldsSet.userErrors);
        } else {
            console.log(`[Warehouse Enroll] Successfully updated metafields for ${foundOrderGid} via App endpoint`);
        }
    } else {
        console.warn(`[Warehouse Enroll] No offline session found to update metafields for ${shopDomain}`);
    }
  } catch (err: any) {
      console.error("[Warehouse Enroll] Failed to update Shopify metafields locally:", err.message);
  }}

  // NOTE: Inventory deduction has been intentionally moved to the upload proxy.
  // This prevents tags from being consumed when photo uploads fail after enrollment.
  // The upload proxy (app.api.warehouse.upload.tsx) deducts 1 tag after a successful upload.

  console.log("[ENROLL] ✅ All done. Returning to frontend:", { proof_id: inkData.proof_id, state: inkData.state });
  console.log("══════════════════════════════════════════\n");
  return json({
    success: true,
    proof_id: inkData.proof_id,
    nfcToken: nfc_token,
    state: inkData.state,
    enrolled_at: inkData.enrolled_at,
  });
};

