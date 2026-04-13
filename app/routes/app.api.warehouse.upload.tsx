import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import firestore from "../firestore.server";
import { uploadMedia, createMerchant, adjustMerchantInventory, getShopIdByDomain } from "../services/ink-api.server";
import crypto from "crypto";

/**
 * Public endpoint (authenticated by warehouse JWT only).
 * Proxies media upload requests to INK API using the merchant's api_key.
 *
 * POST /app/api/warehouse/upload
 * Headers: Authorization: Bearer <warehouse_token>
 * Body: multipart/form-data with fields: proof_id, media_type, file
 */

const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    ...init,
  });

/**
 * Extracts a shop identifier from either our HMAC-signed JWT or Alan's JWT.
 * Returns { shop, merchant_id } — at least one will be set on success.
 */
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

    // Alan JWT contains: merchant_id, user_id, email, role
    return {
      shop: payload.shop,
      merchant_id: payload.merchant_id,
    };
  } catch {
    return null;
  }
}

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
    console.log(`[Warehouse Upload] Key not found for ${identifier}. Auto-provisioning...`);
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
      console.log(`[Warehouse Upload] ✅ Provisioned and saved under merchants/${docId}`);
      return apiKey;
    } catch (e: any) {
      console.error("[Warehouse Upload] Auto-provision failed:", e.message);
    }
  }

  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  return new Response(null, { status: 204, headers: corsHeaders });
};

export async function action({ request }: ActionFunctionArgs) {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // --- Auth ---
  const authHeader = request.headers.get("Authorization");
  console.log("\n══════════════════════════════════════════");
  console.log("[UPLOAD] Incoming request, Content-Length:", request.headers.get("content-length"), "bytes");
  console.log("[UPLOAD] Auth header present:", !!authHeader);
  if (!authHeader?.startsWith("Bearer ")) {
    console.log("[UPLOAD] ❌ Missing Authorization header");
    return json({ error: "Unauthorized" }, { status: 401 });
  }

  const tokenPayload = extractTokenPayload(authHeader.slice(7));
  console.log("[UPLOAD] Token decoded:", tokenPayload ? JSON.stringify(tokenPayload) : "NULL");
  if (!tokenPayload) {
    console.log("[UPLOAD] ❌ Token rejected");
    return json({ error: "Invalid or expired token" }, { status: 401 });
  }

  const { shop: shopDomain, merchant_id: merchantId } = tokenPayload;
  console.log("[UPLOAD] shopDomain:", shopDomain, "| merchantId:", merchantId);

  // --- Merchant API Key ---
  console.log("[UPLOAD] Looking up ink_api_key in Firestore...");
  const apiKey = await getMerchantApiKey(shopDomain, merchantId);
  if (!apiKey) {
    console.log("[UPLOAD] ❌ No ink_api_key found for merchant");
    return json({ error: "Merchant not found or not linked to INK" }, { status: 404 });
  }
  console.log("[UPLOAD] ✅ ink_api_key found, prefix:", apiKey.slice(0, 12) + "...");

  // --- Forward multipart to INK API ---
  const formData = await request.formData();
  const proofId = formData.get("proof_id");
  const mediaType = formData.get("media_type");
  const isFirstPhoto = formData.get("is_first_photo") === "true";
  const fileEntry = formData.get("file") as File | null;
  console.log("[UPLOAD] FormData fields:", {
    proof_id: proofId,
    media_type: mediaType,
    is_first_photo: isFirstPhoto,
    file_name: fileEntry?.name,
    file_size: fileEntry ? `${(fileEntry.size / 1024).toFixed(1)} KB` : "none",
    file_type: fileEntry?.type,
  });

  try {
    console.log("[UPLOAD] → Forwarding to Alan's /api/media/upload...");
    const uploadStart = Date.now();
    const result = await uploadMedia(apiKey, formData);
    console.log(`[UPLOAD] ✅ Alan upload responded in ${Date.now() - uploadStart}ms`);
    console.log("[UPLOAD] Alan response:", JSON.stringify(result));

    // Alan's backend automatically deducts inventory during the /api/enroll call.
    // We previously attempted to deduct it here manually, but it caused redundancy 
    // and failed because his schema changed to expect a positive "quantity".

    return json({ success: true, ...result });
  } catch (err: any) {
    console.error("[Warehouse Upload] Error:", err.message);
    return json({ error: err.message || "Upload failed" }, { status: 500 });
  }
}
