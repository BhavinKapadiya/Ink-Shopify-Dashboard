import { type ActionFunctionArgs, type LoaderFunctionArgs } from "react-router";
import firestore from "../firestore.server";
import crypto from "crypto";
import { authenticate } from "../shopify.server";

const INK_API_URL = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
const INK_ADMIN_SECRET = process.env.INK_ADMIN_SECRET || "ink_admin_aeb5c9d6e822a4e57d95a6a2224aada64230e48d89acad5782057fcb865548a2";

/** Build an Alan API URL. The INK_API_URL ends in /api; admin routes are /admin/*, api routes are /api/* */
function getAlanUrl(path: string): string {
  const baseUrl = INK_API_URL.endsWith('/') ? INK_API_URL.slice(0, -1) : INK_API_URL;
  // Strip trailing /api when path already starts with /api/ to avoid doubling
  if (path.startsWith('/api/') && baseUrl.endsWith('/api')) {
    return `${baseUrl.slice(0, -4)}${path}`;
  }
  return `${baseUrl}${path}`;
}

/** Convert shop domain to a merchant slug for Alan's animation API (e.g. taimoor1-2.myshopify.com → taimoor1-2) */
function toMerchantSlug(shopDomain: string): string {
  return shopDomain.replace('.myshopify.com', '').replace(/[^a-z0-9-]/gi, '-').toLowerCase();
}

const JWT_SECRET =
  process.env.WAREHOUSE_JWT_SECRET ||
  process.env.SHOPIFY_API_SECRET ||
  "fallback-dev-secret";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const json = (data: any, init?: ResponseInit) =>
  new Response(JSON.stringify(data), {
    headers: { "Content-Type": "application/json", ...corsHeaders },
    ...init,
  });

function decodeToken(token: string): { shop?: string; merchant_id?: string } | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, signature] = parts;

    const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    console.log(`[settings/media] Decoding token payload keys: ${Object.keys(payload).join(", ")}`);

    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      console.warn(`[settings/media] Token expired at ${new Date(payload.exp * 1000).toISOString()}`);
      return null;
    }

    // Case 1: Our own HMAC-signed warehouse JWT (has 'shop' or 'merchant_id')
    const expectedSig = crypto
      .createHmac("sha256", JWT_SECRET)
      .update(`${header}.${body}`)
      .digest("base64url");

    if (signature === expectedSig) {
      console.log(`[settings/media] Token verified as our own HMAC JWT. shop=${payload.shop}, merchant_id=${payload.merchant_id}`);
      return { shop: payload.shop, merchant_id: payload.merchant_id };
    }

    // Case 2: Shopify App Bridge session token.
    // These have: iss (store URL), dest (store URL), sub (user gid), aud (api_key)
    // The 'dest' field contains the full store URL like https://taimoor1-2.myshopify.com
    if (payload.dest) {
      // Extract the myshopify domain from the dest URL
      const destUrl = payload.dest as string;
      const shopDomain = destUrl.replace("https://", "").replace("http://", "").replace(/\/$/, "");
      console.log(`[settings/media] Token is Shopify App Bridge session token. Extracted shop domain: ${shopDomain}`);
      return { shop: shopDomain };
    }

    // Case 3: Unknown JWT but has shop or merchant_id - accept with warning
    if (payload.shop || payload.merchant_id) {
      console.warn(`[settings/media] Token not HMAC-verified but has shop/merchant_id. shop=${payload.shop}, merchant_id=${payload.merchant_id}`);
      return { shop: payload.shop, merchant_id: payload.merchant_id };
    }

    console.warn(`[settings/media] Token has none of: dest, shop, merchant_id. Cannot identify merchant.`);
    return null;
  } catch (e: any) {
    console.error(`[settings/media] Failed to decode token:`, e.message);
    return null;
  }
}

async function getMerchantDoc(shopDomain?: string, merchantId?: string) {
  if (merchantId) {
    const doc = await firestore.collection("merchants").doc(merchantId).get();
    if (doc.exists) return doc;
  }
  if (shopDomain) {
    const snapshot = await firestore
      .collection("merchants")
      .where("shopDomain", "==", shopDomain)
      .limit(1)
      .get();
    if (!snapshot.empty) return snapshot.docs[0];
  }
  return null;
}

export const loader = async ({ request }: LoaderFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let shopDomain = "";
  let merchantId = "";
  const authHeader = request.headers.get("Authorization");
  console.log(`[settings/media] GET incoming. Authorization header present: ${!!authHeader}`);

  // Step 1: Try Shopify embedded session (for Shopify Admin app)
  try {
      const { session } = await authenticate.admin(request);
      shopDomain = session.shop;
      console.log(`[settings/media] GET auth: Shopify session OK. shop=${shopDomain}`);
  } catch (err) {
      if (err instanceof Response) {
          console.warn(`[settings/media] GET auth: Shopify returned a redirect/re-auth Response (status=${err.status}). Bubbling up.`);
          throw err;
      }
      console.warn(`[settings/media] GET auth: Shopify session failed (${(err as any)?.message}). Trying Bearer token fallback...`);

      // Step 2: Fallback - Bearer token (PWA warehouse or App Bridge session token)
      if (!authHeader?.startsWith("Bearer ")) {
        console.error(`[settings/media] GET auth: No valid Authorization header found. Returning 401.`);
        return json({ error: "Unauthorized - No valid session or token" }, { status: 401 });
      }
      const rawToken = authHeader.slice(7);
      console.log(`[settings/media] GET auth: Attempting to decode Bearer token (length=${rawToken.length})...`);
      const tokenPayload = decodeToken(rawToken);
      if (!tokenPayload) {
        console.error(`[settings/media] GET auth: Bearer token could not be decoded or has no shop identifier. Returning 401.`);
        return json({ error: "Invalid or expired token" }, { status: 401 });
      }
      shopDomain = tokenPayload.shop || "";
      merchantId = tokenPayload.merchant_id || "";
      console.log(`[settings/media] GET auth: Bearer token decoded OK. shop=${shopDomain}, merchant_id=${merchantId}`);
  }

  if (!shopDomain && !merchantId) {
      console.error(`[settings/media] GET auth: Both shopDomain and merchantId are empty after auth. Returning 401.`);
      return json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log(`[settings/media] GET proceeding for domain=${shopDomain}, merchantId=${merchantId}`);

  try {
    const doc = await getMerchantDoc(shopDomain, merchantId);
    if (!doc) {
      console.log(`[settings/media] No merchant doc found for ${shopDomain || merchantId}`);
    }
    const data = doc?.data() ?? {};
    
    console.log(`[settings/media] GET success, found ${data.merchant_media?.length || 0} media items`);

    return json({
      media: data.merchant_media ?? [],
    });
  } catch (err: any) {
    console.error("[settings/media] GET error:", err.message);
    return json({ error: "Failed to fetch media settings" }, { status: 500 });
  }
};

export const action = async ({ request }: ActionFunctionArgs) => {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  let shopDomain = "";
  let merchantId = "";
  const authHeader = request.headers.get("Authorization");
  console.log(`[settings/media] ${request.method} incoming. Authorization header present: ${!!authHeader}`);

  // Step 1: Try Shopify embedded session (for Shopify Admin app)
  try {
      const { session } = await authenticate.admin(request);
      shopDomain = session.shop;
      console.log(`[settings/media] ${request.method} auth: Shopify session OK. shop=${shopDomain}`);
  } catch (err) {
      if (err instanceof Response) {
          console.warn(`[settings/media] ${request.method} auth: Shopify re-auth Response (status=${(err as Response).status}). Bubbling.`);
          throw err;
      }
      console.warn(`[settings/media] ${request.method} auth: Shopify session failed (${(err as any)?.message}). Trying Bearer token...`);

      // Step 2: Fallback - Bearer token (PWA warehouse or App Bridge session token)
      if (!authHeader?.startsWith("Bearer ")) {
        console.error(`[settings/media] ${request.method} auth: No valid Authorization header. Returning 401.`);
        return json({ error: "Unauthorized - No valid session or token" }, { status: 401 });
      }
      const rawToken = authHeader.slice(7);
      console.log(`[settings/media] ${request.method} auth: Decoding Bearer token (length=${rawToken.length})...`);
      const tokenPayload = decodeToken(rawToken);
      if (!tokenPayload) {
        console.error(`[settings/media] ${request.method} auth: Token invalid or no shop identifier. Returning 401.`);
        return json({ error: "Invalid or expired token" }, { status: 401 });
      }
      shopDomain = tokenPayload.shop || "";
      merchantId = tokenPayload.merchant_id || "";
      console.log(`[settings/media] ${request.method} auth: Bearer token OK. shop=${shopDomain}, merchant_id=${merchantId}`);
  }

  if (!shopDomain && !merchantId) {
      console.error(`[settings/media] ${request.method} auth: Empty shopDomain and merchantId after auth. Returning 401.`);
      return json({ error: "Unauthorized" }, { status: 401 });
  }

  console.log(`[settings/media] ${request.method} proceeding for domain=${shopDomain}, merchantId=${merchantId}`);

  try {
    const doc = await getMerchantDoc(shopDomain, merchantId);
    let merchantMedia = doc?.data()?.merchant_media || [];

    // POST: Upload Media
    if (request.method === "POST") {
      console.log(`[settings/media] Processing POST upload...`);
      const formData = await request.formData();
      const fileEntry = formData.get("file") as File | null;
      
      if (!fileEntry) {
          console.warn(`[settings/media] POST failed: No file payload found!`);
          return json({ error: "No file uploaded" }, { status: 400 });
      }
      
      console.log(`[settings/media] File received: ${fileEntry.name} (${fileEntry.size} bytes, type=${fileEntry.type})`);

      // Derive the merchant name/slug for Alan's merchant-animation API
      const merchantSlug = shopDomain ? toMerchantSlug(shopDomain) : (merchantId || "unknown");
      console.log(`[settings/media] Uploading to Alan merchant-animations. merchantSlug=${merchantSlug}`);

      // Alan's merchant branding endpoint uses:
      //   POST /admin/merchant-animations/upload
      //   Form fields: merchant (string), animation (file)
      //   Auth: Bearer <admin_jwt> (INK_ADMIN_SECRET)
      const uploadForm = new FormData();
      uploadForm.append("merchant", merchantSlug);
      uploadForm.append("animation", fileEntry, fileEntry.name);

      const uploadUrl = getAlanUrl("/admin/merchant-animations/upload");
      console.log(`[settings/media] POST → ${uploadUrl}`);

      let uploadResult: any = {};
      try {
          const uploadResp = await fetch(uploadUrl, {
              method: "POST",
              headers: {
                  "Authorization": `Bearer ${INK_ADMIN_SECRET}`,
                  // DO NOT set Content-Type — let fetch set multipart boundary automatically
              },
              body: uploadForm,
          });

          const rawResponse = await uploadResp.text();
          console.log(`[settings/media] Alan merchant-animations/upload status: ${uploadResp.status}`);
          console.log(`[settings/media] Alan merchant-animations/upload response: ${rawResponse}`);

          if (!uploadResp.ok) {
              console.error(`[settings/media] Alan upload failed (${uploadResp.status}): ${rawResponse}`);
              return json({ error: `Storage upload failed: ${rawResponse}` }, { status: 500 });
          }

          uploadResult = JSON.parse(rawResponse);
      } catch (err: any) {
          console.error(`[settings/media] Exception calling Alan merchant-animations API:`, err.message);
          return json({ error: "Failed to contact storage API" }, { status: 500 });
      }

      // Alan returns: { merchant_name, slug, media_id, media_url, animation_url }
      const finalUrl = uploadResult.media_url || uploadResult.animation_url;
      const mediaId = uploadResult.media_id || crypto.randomUUID();
      
      if (!finalUrl) {
          console.error(`[settings/media] Alan's response did not contain a URL! Full response:`, uploadResult);
          return json({ error: "Storage API returned no URL" }, { status: 500 });
      }

      console.log(`[settings/media] Upload SUCCESS. media_id=${mediaId}, url=${finalUrl}`);

      const newItem = {
          id: mediaId,
          url: finalUrl,
          name: fileEntry.name,
          type: fileEntry.type.startsWith("video") ? "video" : "image",
          duration: formData.get("duration") || "5s",
          size: `${(fileEntry.size / 1024).toFixed(1)} KB`,
          uploadDate: new Date().toLocaleDateString(),
          merchantSlug,
      };
      
      merchantMedia.push(newItem);
      
      if (doc) {
          console.log(`[settings/media] Saving to Firestore (${merchantMedia.length} total items)`);
          await doc.ref.update({ merchant_media: merchantMedia, updatedAt: new Date() });
      } else {
          console.warn(`[settings/media] Cannot save to Firestore — merchant doc is null!`);
      }

      return json({ success: true, item: newItem, media: merchantMedia });
    }
    
    // DELETE: Remove media
    else if (request.method === "DELETE") {
       const body = await request.json();
       const { id } = body;
       console.log(`[settings/media] DELETE media id=${id}`);
       
       // Find the item to get the merchantSlug for Alan API call
       const item = merchantMedia.find((m: any) => m.id === id);
       
       // Try to delete from Alan's API too (best effort — don't fail if it errors)
       if (item?.merchantSlug) {
           const deleteUrl = getAlanUrl(`/admin/merchant-animations/${item.merchantSlug}/${id}`);
           console.log(`[settings/media] Calling Alan DELETE → ${deleteUrl}`);
           try {
               const delResp = await fetch(deleteUrl, {
                   method: "DELETE",
                   headers: { "Authorization": `Bearer ${INK_ADMIN_SECRET}` }
               });
               console.log(`[settings/media] Alan DELETE response: ${delResp.status}`);
           } catch (e: any) {
               console.warn(`[settings/media] Non-fatal: Alan DELETE failed: ${e.message}`);
           }
       }
       
       merchantMedia = merchantMedia.filter((m: any) => m.id !== id);
       if (doc) {
           await doc.ref.update({ merchant_media: merchantMedia, updatedAt: new Date() });
       }
       return json({ success: true, media: merchantMedia });
    }
    
    // PATCH: Reorder or update metadata
    else if (request.method === "PATCH") {
       const body = await request.json();
       if (body.reorderedIds) {
           const reorderedIds: string[] = body.reorderedIds;
           const newMedia = [];
           for (const rid of reorderedIds) {
               const item = merchantMedia.find((m: any) => m.id === rid);
               if (item) newMedia.push(item);
           }
           merchantMedia = newMedia;
       } else if (body.setPrimaryId) {
           const id = body.setPrimaryId;
           const idx = merchantMedia.findIndex((m: any) => m.id === id);
           if (idx > 0) {
              const [moved] = merchantMedia.splice(idx, 1);
              merchantMedia.unshift(moved);
           }
       } else if (body.updateMetadata) {
           // Duration, loop, etc.
           const { id, updates } = body.updateMetadata;
           const idx = merchantMedia.findIndex((m: any) => m.id === id);
           if (idx >= 0) {
               merchantMedia[idx] = { ...merchantMedia[idx], ...updates };
           }
       }
       
       if (doc) {
           await doc.ref.update({ merchant_media: merchantMedia, updatedAt: new Date() });
       }
       return json({ success: true, media: merchantMedia });
    }

    return json({ error: "Method not allowed" }, { status: 405 });
  } catch (err: any) {
    console.error("[settings/media] Action error:", err.message);
    return json({ error: "Failed to modify settings" }, { status: 500 });
  }
};
