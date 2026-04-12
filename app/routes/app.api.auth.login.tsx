import { type ActionFunctionArgs } from "react-router";
import firestore from "../firestore.server";
import { createMerchant, loginUser, getShopIdByDomain } from "../services/ink-api.server";
import bcrypt from "bcryptjs";
import crypto from "crypto";

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: {
      "Content-Type": "application/json",
      // Allow the Firebase-hosted warehouse app to call this endpoint
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
    ...init,
  });

const COLLECTION = "warehouse_users";
const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

// Simple JWT-like token using HMAC-SHA256
function createToken(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(`${header}.${body}`)
    .digest("base64url");
  return `${header}.${body}.${signature}`;
}

// Handle CORS preflight
export const loader = async () => {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    },
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  // Handle CORS preflight
  if (request.method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
      },
    });
  }

  let body: { email?: string; password?: string };
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const { email, password } = body;

  if (!email || !password) {
    return json({ error: "Email and password are required" }, { status: 400 });
  }

  // ==========================================
  // 1. INK v1.3.0 Primary Authentication Path
  // ==========================================
  try {
    console.log(`\n===========================================`);
    console.log(`[Auth Proxy] 🚀 Intercepting Login Request`);
    console.log(`[Auth Proxy] Email: ${email}`);
    console.log(`[Auth Proxy] Routing to INK Backend...`);
    
    const inkResponse = await loginUser(email, password);
    const inkUser = inkResponse.user;
    let merchantId = inkUser.merchant_id; // Alan might have polluted this with the domain

    // Auto-correct if merchantId is a domain instead of shop_xxx
    if (merchantId && !merchantId.startsWith("shop_")) {
      console.log(`[Auth Proxy] ⚠️ Detected domain instead of shop_id (${merchantId}). Resolving...`);
      try {
        merchantId = await getShopIdByDomain(merchantId);
      } catch (e: any) {
         console.warn(`[Auth Proxy] Could not resolve shop_id for Domain: ${merchantId}`);
      }
    }

    console.log(`[Auth Proxy] ✅ INK Login verified for: ${email}`);
    console.log(`[Auth Proxy] 🏢 Linked Merchant Domain: ${merchantId}`);

    // Proactively cache/refresh the merchant's ink_api_key in Firestore.
    // This ensures the warehouse proxies can always look it up without failing.
    if (merchantId) {
      try {
        // Try to get or create the merchant on Alan's side (handles both new + reinstall)
        const inkMerchantRes = await createMerchant(merchantId, merchantId, email);
        const freshApiKey = inkMerchantRes.api_key;

        if (freshApiKey) {
          // Upsert into Firestore: first try by document ID, then by shopDomain field
          const existingDoc = await firestore.collection("merchants").doc(merchantId).get();
          if (existingDoc.exists) {
            await existingDoc.ref.update({ ink_api_key: freshApiKey, updatedAt: new Date() });
          } else {
            // Also check by shopDomain field  
            const snapshot = await firestore.collection("merchants").where("shopDomain", "==", merchantId).limit(1).get();
            if (!snapshot.empty) {
              await snapshot.docs[0].ref.update({ ink_api_key: freshApiKey, updatedAt: new Date() });
            } else {
              // Create new doc with document ID = original domain OR merchantId
              await firestore.collection("merchants").doc(inkUser.merchant_id || merchantId).set({
                shopDomain: inkUser.merchant_id || merchantId,
                shop_id: merchantId,
                ink_api_key: freshApiKey,
                createdAt: new Date(),
                updatedAt: new Date(),
              }, { merge: true });
            }
          }
          console.log(`[Auth] Cached ink_api_key for merchant ${merchantId}`);
        }
      } catch (cacheErr: any) {
        // Non-fatal: if caching fails, the proxy self-heal will handle it
        console.warn(`[Auth] Could not cache ink_api_key for ${merchantId}:`, cacheErr.message);
      }
    }

    return json({
      token: inkResponse.token,
      userId: inkUser.user_id,
      name: inkUser.name,
      email: inkUser.email,
      role: inkUser.role || 'merchant',
      user: inkUser,
    });
  } catch (error: any) {
    console.warn(`[Auth] INK login failed: ${error.message}. Falling back to legacy Firestore auth...`);
    // If the error is definitively "wrong password" for an INK user, we might want to fail hard here.
    // But for a smooth rollout, we gracefully fall back to checking the legacy db.
  }

  // ==========================================
  // 2. Legacy Firestore Auth Path
  // ==========================================
  // Look up the user by email
  const snapshot = await firestore
    .collection(COLLECTION)
    .where("email", "==", email.toLowerCase())
    .limit(1)
    .get();

  if (snapshot.empty) {
    // Return same error to prevent email enumeration
    return json({ error: "Invalid email or password" }, { status: 401 });
  }

  const userDoc = snapshot.docs[0];
  const userData = userDoc.data();

  // Verify password
  const isValid = await bcrypt.compare(password, userData.passwordHash);
  if (!isValid) {
    return json({ error: "Invalid email or password" }, { status: 401 });
  }

  // Ensure the merchant configuration document exists and has a real INK API key (heal from sk_test_fallback)
  const merchantSnapshot = await firestore
    .collection("merchants")
    .where("shopDomain", "==", userData.shopDomain)
    .limit(1)
    .get();

  let apiKey = merchantSnapshot.empty ? null : merchantSnapshot.docs[0].data().ink_api_key;
  let docId = merchantSnapshot.empty ? null : merchantSnapshot.docs[0].id;
  let realShopId = merchantSnapshot.empty ? null : merchantSnapshot.docs[0].data().shop_id;

  if (!realShopId) {
    try {
       realShopId = await getShopIdByDomain(userData.shopDomain);
       if (realShopId) {
          await firestore.collection("merchants").doc(userData.shopDomain).set({ shop_id: realShopId }, { merge: true });
       }
    } catch (e) {
       // fallback
    }
  }

  if (!apiKey || apiKey === "sk_test_fallback") {
    console.log(`[Auth] Key missing or fallback for ${userData.shopDomain}. Calling INK Admin API...`);
    try {
      const inkRes = await createMerchant(userData.shopDomain, userData.shopDomain, `admin@${userData.shopDomain}`);
      apiKey = inkRes.api_key;
      realShopId = inkRes.shop_id || realShopId;
      await firestore.collection("merchants").doc(userData.shopDomain).set({
        shopDomain: userData.shopDomain,
        ink_api_key: apiKey,
        shop_id: realShopId,
        updatedAt: new Date(),
      }, { merge: true });
    } catch (e: any) {
      console.error("[Auth] Failed to auto-create merchant:", e.message);
      apiKey = process.env.INK_API_KEY || "sk_test_fallback";
      await firestore.collection("merchants").doc(userData.shopDomain).set({
        shopDomain: userData.shopDomain,
        ink_api_key: apiKey,
        updatedAt: new Date(),
      }, { merge: true });
    }
  }

  // Issue a token valid for 8 hours
  const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 8;
  const token = createToken({
    sub: userDoc.id,
    email: userData.email,
    name: userData.name,
    shop: userData.shopDomain,
    merchant_id: realShopId || userData.shopDomain, // strict shop_id insertion
    role: userData.role,
    exp,
  });

  return json({
    token,
    userId: userDoc.id,
    name: userData.name,
    email: userData.email,
    role: userData.role,
  });
};
