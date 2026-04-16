import { authenticate } from "../shopify.server";

const INK_API_URL = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
const INK_ADMIN_SECRET = process.env.INK_ADMIN_SECRET || "ink_admin_aeb5c9d6e822a4e57d95a6a2224aada64230e48d89acad5782057fcb865548a2";

/**
 * Helper to construct the correct URL for Alan's API.
 * Handles the case where INK_API_URL might already end in /api.
 */
/**
 * Helper to construct the correct URL for Alan's API.
 * The production INK_API_URL already ends in /api (e.g. https://.../api).
 * Alan's routes are like /api/enroll, /api/media/upload, /admin/merchants, /auth/login.
 * To avoid doubling (/api/api/...), we strip the trailing /api from the base when needed.
 */
function getAlanUrl(path: string): string {
    const baseUrl = INK_API_URL.endsWith('/') ? INK_API_URL.slice(0, -1) : INK_API_URL;

    // e.g. path = "/api/enroll", baseUrl ends in "/api" → strip it to avoid /api/api/enroll
    if (path.startsWith('/api/') && baseUrl.endsWith('/api')) {
        return `${baseUrl.slice(0, -4)}${path}`; // Remove trailing "/api", prepend base
    }

    // For /admin/*, /auth/*, etc., just append as-is
    return `${baseUrl}${path}`;
}


import crypto from "crypto";

// Admin implementation - requires X-Admin-Secret
export const createMerchant = async (
  shopDomain: string, 
  shopName: string, 
  ownerEmail: string,
  optionalParams?: {
    shopify_plan?: string;
    merchant_category?: string;
    merchant_region?: string;
    avg_order_value?: number;
    primary_carriers?: string[];
    monthly_order_volume?: number;
    pre_ink_dispute_rate?: number;
  }
) => {
  try {
    const payload: any = {
      shop_domain: shopDomain,
      shop_name: shopName,
      owner_email: ownerEmail,
      ...optionalParams
    };

    const response = await fetch(getAlanUrl("/admin/merchants"), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Admin-Secret": INK_ADMIN_SECRET,
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        console.error("INK API Error (createMerchant):", response.status, errorText);
        throw new Error(`Failed to create merchant: ${response.statusText} - ${errorText}`);
    }

    const data = await response.json();
    return data; // Expected { api_key: "..." }
  } catch (error) {
    console.error("INK API Exception:", error);
    throw error;
  }
};

export const getMerchants = async () => {
    const response = await fetch(getAlanUrl("/admin/merchants"), {
        headers: { "X-Admin-Secret": INK_ADMIN_SECRET },
    });
    if (!response.ok) throw new Error("Failed to list merchants");
    return await response.json();
};

export const getShopIdByDomain = async (shopDomain: string): Promise<string> => {
    const listRes = await fetch(getAlanUrl("/admin/merchants?limit=200"), {
        headers: { "X-Admin-Secret": INK_ADMIN_SECRET },
    });
    if (!listRes.ok) throw new Error("Failed to list merchants");
    const { merchants } = await listRes.json();
    const merchant = merchants?.find((m: any) => m.shop_domain === shopDomain);
    if (!merchant) throw new Error(`Merchant not found for domain: ${shopDomain}`);
    return merchant.shop_id;
};

export const adminCreateUser = async (merchantId: string, name: string, email: string, password?: string) => {
    const payload: any = { merchant_id: merchantId, name, email };
    if (password) payload.password = password;

    const response = await fetch(getAlanUrl('/admin/users'), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Admin-Secret": INK_ADMIN_SECRET,
        },
        body: JSON.stringify(payload),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to create user: ${errorText}`);
    }
    return await response.json();
};

export const getMerchantUsers = async (merchantId: string) => {
    const response = await fetch(getAlanUrl(`/admin/users?merchant_id=${merchantId}`), {
        headers: { "X-Admin-Secret": INK_ADMIN_SECRET },
    });
    if (!response.ok) throw new Error("Failed to get merchant users");
    return await response.json();
};

export const deleteMerchantUser = async (userId: string) => {
    const response = await fetch(getAlanUrl(`/admin/users/${userId}`), {
        method: "DELETE",
        headers: { "X-Admin-Secret": INK_ADMIN_SECRET },
    });
    if (!response.ok) throw new Error("Failed to delete merchant user");
    return true;
};

// V1.3.0 Auth Binding
export const loginUser = async (email: string, password: string) => {
    console.log(`\n🔑 [AUTH] =======================================`);
    console.log(`🔑 [AUTH] Initiating INK v1.3.0 Login Flow`);
    console.log(`🔑 [AUTH] URL: ${getAlanUrl('/auth/login')}`);
    console.log(`🔑 [AUTH] Payload: { email: "${email}", password: "***" }`);

    const response = await fetch(getAlanUrl('/auth/login'), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
    });

    console.log(`🔑 [AUTH] Response Status: ${response.status}`);
    
    if (!response.ok) {
        const errorText = await response.text();
        console.error(`🔑 [AUTH] ❌ Login Failed! Body: ${errorText}`);
        throw new Error(errorText || "Invalid email or password constraints");
    }
    
    const data = await response.json();
    console.log(`🔑 [AUTH] ✅ Login Success. Extracted Roles: ${data.user?.role}`);
    console.log(`🔑 [AUTH] =======================================\n`);
    return data;
};

export const validateUserToken = async (token: string) => {
    console.log(`\n🛡️ [AUTH VALIDATE] ================================`);
    console.log(`🛡️ [AUTH VALIDATE] Validating JWT with INK API...`);
    
    const response = await fetch(getAlanUrl('/auth/validate'), {
        method: "GET",
        headers: { 
            "Authorization": `Bearer ${token}` 
        }
    });

    console.log(`🛡️ [AUTH VALIDATE] Response Status: ${response.status}`);

    if (!response.ok) {
         const errorText = await response.text();
         console.error(`🛡️ [AUTH VALIDATE] ❌ Validation Request Failed: ${errorText}`);
         return { valid: false };
    }

    const data = await response.json();
    if (data.valid) {
         console.log(`🛡️ [AUTH VALIDATE] ✅ Token is valid. User: ${data.email}, Role: ${data.role}`);
    } else {
         console.warn(`🛡️ [AUTH VALIDATE] ⚠️ Token rejected by backend.`);
    }
    console.log(`🛡️ [AUTH VALIDATE] JSON Returned:`, JSON.stringify(data));
    console.log(`🛡️ [AUTH VALIDATE] ================================\n`);
    
    return data;
};

// Merchant implementation - requires Bearer ink_api_key
export const enrollOrder = async (
    apiKey: string, 
    orderId: string, 
    nfcToken: string, 
    orderNumber: string,
    customerEmail: string,
    shippingAddress: any,
    productDetails: any[],
    warehouseLocation?: { lat: number; lng: number },
    nfcUid?: string,
    photoUrls?: string[],
    photoHashes?: string[],
    carrierName?: string | null,
    trackingNumber?: string | null,
    customerPhone?: string | null
) => {
    const payload: any = { 
        order_id: orderId,
        nfc_token: nfcToken,
        order_number: orderNumber,
        customer_email: customerEmail || "unknown@email.com",
        customer_phone: customerPhone || "",
        shipping_address: shippingAddress,
        product_details: productDetails,
        order_details: {
            order_id: orderId,
            order_number: orderNumber,
            customer_email: customerEmail || "unknown@email.com",
            customer_phone: customerPhone || "",
            shipping_address: shippingAddress,
            product_details: productDetails
        }
    };
    
    if (warehouseLocation) payload.warehouse_location = warehouseLocation;
    if (nfcUid) payload.nfc_uid = nfcUid;
    if (photoUrls && photoUrls.length > 0) payload.photo_urls = photoUrls;
    if (photoHashes && photoHashes.length > 0) payload.photo_hashes = photoHashes;
    if (carrierName) payload.carrier_name = carrierName;
    if (trackingNumber) payload.tracking_number = trackingNumber;

    const enrollUrl = getAlanUrl('/api/enroll');
    console.log("[ink-api] enrollOrder →", enrollUrl);
    console.log("[ink-api] enrollOrder payload (no sensitive):", JSON.stringify({ order_id: payload.order_id, nfc_token: payload.nfc_token, order_number: payload.order_number }));
    const response = await fetch(enrollUrl, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify(payload),
    });

    console.log("[ink-api] enrollOrder response status:", response.status, response.statusText);
    if (!response.ok) {
        const errText = await response.text();
        console.error("[ink-api] enrollOrder error body:", errText);
        throw new Error(`Enrollment failed: ${errText}`);
    }
    return await response.json();
};

export const getProof = async (apiKey: string, nfcToken: string) => {
    const response = await fetch(getAlanUrl(`/api/proofs/${nfcToken}`), {
        headers: {
            "Authorization": `Bearer ${apiKey}`,
        },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Get proof failed: ${await response.text()}`);
    return await response.json();
};

export const getProofByNfc = async (apiKey: string, nfcUid: string) => {
    const response = await fetch(getAlanUrl(`/api/proofs/nfc/${nfcUid}`), {
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json",
        },
    });
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`Get proof by NFC failed: ${await response.text()}`);
    return await response.json();
};

export const getInventory = async (apiKey: string) => {
    const response = await fetch(getAlanUrl('/api/inventory'), {
        headers: {
            "Authorization": `Bearer ${apiKey}`,
        },
    });
    if (!response.ok) throw new Error(`Get inventory failed: ${await response.text()}`);
    return await response.json();
};

/**
 * Admin-level inventory lookup that doesn't require a merchant API key.
 * Finds the shop_id from the INK merchants list, then POSTs a zero-delta 
 * (or reads from Firestore directly). Falls back gracefully.
 */
export const getInventoryByShopDomain = async (shopDomain: string): Promise<{ current_count: number; total_purchased: number; used_this_month: number; recent_transactions: any[] }> => {
    // 1. Find the shop_id for this domain
    const listRes = await fetch(getAlanUrl("/admin/merchants?limit=200"), {
        headers: { "X-Admin-Secret": INK_ADMIN_SECRET },
    });
    if (!listRes.ok) throw new Error("Failed to list merchants");
    const { merchants } = await listRes.json();

    const merchant = merchants?.find((m: any) => m.shop_domain === shopDomain);
    if (!merchant) throw new Error(`Merchant not found for domain: ${shopDomain}`);

    const shopId = merchant.shop_id;

    // 2. Use admin endpoint with quantity 1 and then -1 to read balance? 
    //    No — that mutates data. Instead let's POST a replenishment of 0.
    //    But the API rejects quantity: 0. So we'll try the merchant-level GET /api/inventory
    //    using the merchant's api_key if available, or reconstruct from Firestore ledger.

    // Actually, the simplest reliable approach: 
    // Query sticker_inventory_ledger in Firestore directly for this shop_id,
    // since we already have Firestore access on the server.
    // Import is at top level, but we can dynamic-import here.
    const firestore = (await import("../firestore.server")).default;

    // Get all ledger entries for this shop, sort in memory to avoid Firestore index requirements
    const ledgerSnap = await firestore
        .collection("sticker_inventory_ledger")
        .where("shop_id", "==", shopId)
        .get();

    if (ledgerSnap.empty) {
        return { current_count: 0, total_purchased: 0, used_this_month: 0, recent_transactions: [] };
    }
    // Sort descending by created_at
    const docs = ledgerSnap.docs.map(doc => doc.data());
    docs.sort((a, b) => {
        const timeA = new Date(a.created_at || 0).getTime();
        const timeB = new Date(b.created_at || 0).getTime();
        return timeB - timeA;
    });

    // The first doc has the latest balance
    const latestEntry = docs[0];
    const currentCount = latestEntry.balance_after || 0;

    // Calculate "Used This Month" and "Total Purchased"
    const now = new Date();
    const currentMonth = now.getMonth();
    const currentYear = now.getFullYear();
    
    let usedThisMonth = 0;
    let totalPurchased = 0;
    docs.forEach(d => {
        const dDate = new Date(d.created_at || 0);
        if (d.quantity_change > 0) {
            totalPurchased += d.quantity_change;
        }
        if (dDate.getMonth() === currentMonth && dDate.getFullYear() === currentYear) {
            if (d.quantity_change < 0) {
                usedThisMonth += Math.abs(d.quantity_change);
            }
        }
    });

    // Map the last 10 transactions
    const recentTransactions = docs.slice(0, 10).map((d: any) => {
        return {
            timestamp: d.created_at,
            delta: d.quantity_change,
            reason: d.order_id || d.transaction_type || "unknown",
            new_balance: d.balance_after,
        };
    });

    return { 
        current_count: currentCount, 
        total_purchased: totalPurchased || 100, // Fallback to 100 if no positive changes found
        used_this_month: usedThisMonth,
        recent_transactions: recentTransactions 
    };
};

export const uploadMedia = async (apiKey: string, formData: FormData) => {
    // Note: In Node 18+, native fetch supports FormData directly.
    // However, some Firebase Function environments or Cloud Run environments might 
    // have issues if the boundary is not correctly negotiated or if the stream is consumed.
    
    const uploadUrl = getAlanUrl('/api/media/upload');
    console.log("[ink-api] uploadMedia →", uploadUrl);
    console.log("[ink-api] uploadMedia API key prefix:", apiKey.slice(0, 12) + "...");

    const response = await fetch(uploadUrl, {
        method: "POST",
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            // We MUST NOT set Content-Type for FormData; fetch will set it with the boundary
        },
        body: formData, 
    });

    console.log("[ink-api] uploadMedia response status:", response.status, response.statusText);
    if (!response.ok) {
        const rawError = await response.text();
        console.error(`[ink-api] uploadMedia error ${response.status}:`, rawError);
        
        let errorMsg = rawError;
        try {
            const parsed = JSON.parse(rawError);
            errorMsg = parsed.error || parsed.message || rawError;
        } catch {
            // Not JSON
        }

        if (response.status === 503 || response.status === 504) {
          throw new Error(`Alan upload API unavailable (${response.status}) — try again or reduce photo size.`);
        }

        throw new Error(`Alan Upload failed (${response.status}): ${errorMsg}`);
    }
    return await response.json();
};

/**
 * Adjusts a merchant's inventory by a given delta.
 * Used for deductions (negative delta) or replenishments (positive delta).
 */
export const adjustMerchantInventory = async (shopId: string, delta: number, reason: string) => {
    const response = await fetch(getAlanUrl(`/admin/merchants/${shopId}/inventory`), {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "X-Admin-Secret": INK_ADMIN_SECRET,
        },
        body: JSON.stringify({ delta, reason }),
    });

    if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Failed to adjust inventory: ${errorText}`);
    }
    return await response.json();
};

export const healthCheck = async () => {
    try {
        const response = await fetch(getAlanUrl('/api/health'));
        return response.ok;
    } catch (e) {
        return false;
    }
};

/**
 * Implements cryptographic integrity check for a fetched proof record.
 * 
 * Fetches the Ed25519 public key from the INK API's /.well-known/jwks.json endpoint
 * and uses Node's native crypto module to verify the signature against the payload hash.
 */
export const verifyProofSignature = async (proof: any): Promise<boolean> => {
    try {
        if (!proof || !proof.signature || !proof.payload_hash || !proof.key_id) {
            console.warn("INK API: Proof is missing cryptographic signature fields.");
            return false;
        }

        // 1. Fetch public JWKS from the INK backend
        const jwksReq = await fetch(getAlanUrl('/.well-known/jwks.json'));
        if (!jwksReq.ok) {
            console.error("INK API: Failed to fetch JWKS for signature verification");
            return false;
        }
        const jwk = await jwksReq.json();

        // 2. Verify the key_id matches
        if (jwk.kid !== proof.key_id) {
            console.warn(`INK API: Key ID mismatch. Proof used ${proof.key_id}, Server provides ${jwk.kid}`);
            return false;
        }

        // 3. Create a public key object from the JWK
        const publicKey = crypto.createPublicKey({
            key: jwk,
            format: "jwk",
        });

        // 4. Verify the Ed25519 signature
        // Crypto verify: Node.js expects `null` for the algorithm when using EdDSA/Ed25519
        const isValid = crypto.verify(
            null,
            Buffer.from(proof.payload_hash, "hex"),
            publicKey,
            Buffer.from(proof.signature, "hex")
        );

        return isValid;
    } catch (error) {
        console.error("INK API Signature Verification Error:", error);
        return false;
    }
};
