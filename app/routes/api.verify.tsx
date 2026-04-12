import { type ActionFunctionArgs } from "react-router";
import { serialNumberToToken } from "../utils/nfc-conversion.server";
import { INK_NAMESPACE } from "../utils/metafields.server";
import { getProof } from "../services/ink-api.server";
import firestore from "../firestore.server";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With, Origin",
};

// Handle OPTIONS preflight
export const loader = async () => {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
};

export const action = async ({ request }: ActionFunctionArgs) => {
    // CRITICAL: Log EVERY request that hits this endpoint
    console.log("\n🚨 =================================================");
    console.log("🚨 /api/verify ENDPOINT HIT");
    // ... (logging omitted for brevity in diff, but kept in logic via imports/structure) ...

    try {
        const payload = await request.json();
        console.log("📥 Raw payload received:", JSON.stringify(payload, null, 2));

        const { serial_number, delivery_gps, device_info, phone_last4 } = payload;

        if (!serial_number || !delivery_gps) {
            console.error("❌ Validation failed: Missing serial_number or delivery_gps");
            return new Response(
                JSON.stringify({ error: "Missing required fields: serial_number and delivery_gps" }),
                { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        // DETERMINISTIC: Compute token directly from serial number
        const { uid, token } = serialNumberToToken(serial_number);
        console.log(`✅ Computed from serial: UID="${uid}", Token="${token.substring(0, 20)}..."`);

        // Call Alan's API directly
        console.log("🚀 Calling Alan's INK API to check verify status...");
        
        let apiKey: string | null = null;
        try {
            const merchantsSnapshot = await firestore.collection("merchants").limit(10).get();
            for (const doc of merchantsSnapshot.docs) {
                const key = doc.data().ink_api_key;
                if (key && key !== "sk_test_fallback") {
                    apiKey = key;
                    break;
                }
            }
        } catch (fsErr) {
            console.warn("⚠️ Firestore unavailable for API key lookup:", fsErr);
        }

        if (!apiKey) {
            apiKey = process.env.INK_API_KEY || "";
        }

        if (!apiKey) {
            console.error("❌ No INK API key available for verification");
            return new Response(
                JSON.stringify({ error: "No API key available" }),
                { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        // 0. Register tap event with Alan's tracking endpoint before fetching proof details
        try {
            const INK_API_BASE = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
            console.log(`[verify] Registering tap event to Alan: POST ${INK_API_BASE}/verify`);
            await fetch(`${INK_API_BASE}/verify`, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                    "Authorization": `Bearer ${apiKey}`
                },
                body: JSON.stringify({
                    nfc_token: token,
                    tap_timestamp: new Date().toISOString(),
                    tap_latitude: delivery_gps?.lat || 0,
                    tap_longitude: delivery_gps?.lng || 0,
                    tap_type: "delivery_confirmation"
                })
            });
            console.log(`[verify] ✅ Tap event registered successfully.`);
        } catch (postErr) {
            console.warn(`[verify] ⚠️ Failed to explicitly post tap event to Alan:`, postErr);
        }

        const alanData = await getProof(apiKey, token);

        if (!alanData) {
            console.error("❌ Verification failed: Proof not found on INK API");
            return new Response(
                JSON.stringify({ error: "Proof not found" }),
                { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        console.log("✅ INK server response state:", alanData.state, "outcome:", alanData.delivery_outcome);

        // ================================================================
        // MERCHANT BRANDING MEDIA INJECTION
        // Goal: Find the merchant's uploaded branding video and attach it
        // to the verify response so ConsumerTap.tsx can render it.
        // ================================================================
        console.log(`[verify] ============= MERCHANT MEDIA INJECTION =============`);
        console.log(`[verify] Proof shop_domain from Alan: "${alanData.shop_domain}"`);
        console.log(`[verify] Proof shop_id from Alan: "${alanData.shop_id}"`);
        console.log(`[verify] apiKey used for this proof: ${apiKey?.slice(0, 15)}...`);

        let merchantMedia: any[] = [];
        let merchantAnimationUrl: string | null = null;

        try {
            // ── Step 1: Identify the merchant from the proof's shop_domain ──
            // Alan's proof returns shop_domain. Use that to find Firestore merchant record.
            const proofShopDomain = alanData.shop_domain || alanData.merchant_id || "";
            console.log(`[verify] Looking up Firestore merchant by shop_domain: "${proofShopDomain}"`);

            let merchantDoc: any = null;
            let merchantSlug = "";

            if (proofShopDomain) {
                const merchantSnap = await firestore
                    .collection("merchants")
                    .where("shopDomain", "==", proofShopDomain)
                    .limit(1)
                    .get();

                if (!merchantSnap.empty) {
                    merchantDoc = merchantSnap.docs[0].data();
                    merchantSlug = proofShopDomain.replace(".myshopify.com", "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
                    console.log(`[verify] ✅ Found Firestore merchant for shop_domain. Slug: "${merchantSlug}". Has merchant_media: ${(merchantDoc.merchant_media || []).length} items.`);
                    merchantMedia = merchantDoc.merchant_media || [];
                } else {
                    console.warn(`[verify] ⚠️ No Firestore merchant found for shop_domain: "${proofShopDomain}". Trying api_key fallback...`);
                    // Fallback: search by apiKey used for this proof  
                    const keySnap = await firestore
                        .collection("merchants")
                        .where("ink_api_key", "==", apiKey)
                        .limit(1)
                        .get();
                    if (!keySnap.empty) {
                        merchantDoc = keySnap.docs[0].data();
                        const fallbackDomain = merchantDoc.shopDomain || "";
                        merchantSlug = fallbackDomain.replace(".myshopify.com", "").replace(/[^a-z0-9-]/gi, "-").toLowerCase();
                        console.log(`[verify] ✅ Found merchant via api_key fallback. Domain: "${fallbackDomain}", Slug: "${merchantSlug}". merchant_media: ${(merchantDoc.merchant_media || []).length} items.`);
                        merchantMedia = merchantDoc.merchant_media || [];
                    } else {
                        console.error(`[verify] ❌ No Firestore merchant found by shop_domain OR api_key. Branding will be empty.`);
                    }
                }
            } else {
                console.warn(`[verify] ⚠️ Alan proof has no shop_domain field. Cannot look up branding merchant.`);
            }

            // ── Step 2: Fetch the animation_url directly from Alan's merchant-animations API ──
            // This is the authoritative primary URL set via the Shopify media panel.
            if (merchantSlug) {
                const INK_API_BASE = process.env.INK_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
                const INK_ADMIN_SECRET = process.env.INK_ADMIN_SECRET || "ink_admin_aeb5c9d6e822a4e57d95a6a2224aada64230e48d89acad5782057fcb865548a2";
                // Build the URL — strip trailing /api since admin routes are already /admin/*
                const baseUrl = INK_API_BASE.endsWith("/api") ? INK_API_BASE.slice(0, -4) : INK_API_BASE;
                const animsUrl = `${baseUrl}/admin/merchant-animations/${merchantSlug}`;
                
                console.log(`[verify] Calling Alan GET merchant-animations: ${animsUrl}`);
                try {
                    const animResp = await fetch(animsUrl, {
                        headers: { "Authorization": `Bearer ${INK_ADMIN_SECRET}` }
                    });
                    const animRaw = await animResp.text();
                    console.log(`[verify] Alan merchant-animations status: ${animResp.status}`);
                    console.log(`[verify] Alan merchant-animations response: ${animRaw}`);

                    if (animResp.ok) {
                        const animData = JSON.parse(animRaw);
                        // animData has: animation_url, media_items: [{media_id, media_url, is_active}]
                        merchantAnimationUrl = animData.animation_url || null;
                        console.log(`[verify] ✅ Alan primary animation_url: "${merchantAnimationUrl}"`);
                        console.log(`[verify] Alan media_items count: ${(animData.media_items || []).length}`);

                        // Merge Alan's media_items into merchantMedia if Firestore was empty
                        if (merchantMedia.length === 0 && (animData.media_items || []).length > 0) {
                            merchantMedia = animData.media_items.map((item: any) => ({
                                id: item.media_id,
                                url: item.media_url,
                                type: (item.media_url || "").match(/\.(mp4|webm|mov|gif)$/i) ? "video" : "image",
                                name: item.media_id,
                                isPrimary: item.media_id === animData.primary_media_id,
                            }));
                            console.log(`[verify] Populated ${merchantMedia.length} items from Alan media_items.`);
                        }

                        // If Alan provides a primary animation_url, inject it as the first item
                        if (merchantAnimationUrl) {
                            const primaryItem = {
                                id: animData.primary_media_id || "primary",
                                url: merchantAnimationUrl,
                                type: merchantAnimationUrl.match(/\.(mp4|webm|mov|gif)$/i) ? "video" : "image",
                                name: "primary-brand-animation",
                                isPrimary: true,
                            };
                            // Put primary at front, deduplicate by URL
                            merchantMedia = [
                                primaryItem,
                                ...merchantMedia.filter((m: any) => m.url !== merchantAnimationUrl)
                            ];
                            console.log(`[verify] ✅ Injected primary animation as first media item. Total: ${merchantMedia.length}`);
                        }
                    } else {
                        console.warn(`[verify] ⚠️ Alan merchant-animations responded non-OK (${animResp.status}). Relying on Firestore merchant_media only.`);
                    }
                } catch (animErr: any) {
                    console.warn(`[verify] ⚠️ Alan merchant-animations call failed: ${animErr.message}. Using Firestore only.`);
                }
            }

            if (merchantMedia.length > 0) {
                alanData.merchant_media = merchantMedia;
                console.log(`[verify] ✅ Injected ${merchantMedia.length} merchant_media items into verify response. Primary URL: ${merchantMedia[0]?.url}`);
            } else {
                console.warn(`[verify] ⚠️ No merchant_media found from any source. ConsumerTap will use default bumper.`);
                alanData.merchant_media = [];
            }
        } catch (err: any) {
            console.error(`[verify] ❌ Exception during merchant media injection:`, err.message);
            alanData.merchant_media = [];
        }
        console.log(`[verify] ============= END MERCHANT MEDIA INJECTION =============`);

        // =================================================================
        // FALLBACK: Update metafields immediately (redundancy with webhook)
        // This ensures dashboard updates even if webhook fails/is not configured
        // =================================================================
        (async () => {
            try {
                console.log("\n📝 =================================================");
                console.log("📝 Updating Metafields as Fallback");
                console.log("📝 =================================================");
                
                const { default: firestore } = await import("../firestore.server");
                
                // --- MULTI-TENANT SAFE: Search ALL offline sessions ---
                const sessionSnapshot = await firestore.collection("shopify_sessions").where("isOnline", "==", false).get();
                if (sessionSnapshot.empty) {
                    console.warn("⚠️ No offline sessions found for fallback metafield update");
                    return;
                }
                const offlineSessions = sessionSnapshot.docs.map(doc => doc.data());

                let foundOrderGid: string | null = null;
                let foundSession: any = null;

                for (const sess of offlineSessions) {
                    if (!sess.accessToken) continue;

                    const adminGraphql = async (query: string, variables?: any) => {
                        const response = await fetch(`https://${sess.shop}/admin/api/2024-10/graphql.json`, {
                            method: "POST",
                            headers: {
                                "Content-Type": "application/json",
                                "X-Shopify-Access-Token": sess.accessToken,
                            },
                            body: JSON.stringify({ query, variables }),
                        });
                        return response.json();
                    };

                    const searchQuery = `#graphql
                        query SearchOrderByProof($query: String!) {
                            orders(first: 1, query: $query) {
                                edges { node { id name } }
                            }
                        }
                    `;
                    console.log(`🔍 Searching in ${sess.shop} for proof_id: ${alanData.proof_id}`);
                    const searchResult = await adminGraphql(searchQuery, { 
                        query: `metafield.ink.proof_reference:${alanData.proof_id}` 
                    });
                    
                    if (searchResult?.data?.orders?.edges?.length > 0) {
                        foundOrderGid = searchResult.data.orders.edges[0].node.id;
                        foundSession = sess;
                        console.log(`✅ Found order ${searchResult.data.orders.edges[0].node.name} in ${sess.shop}`);
                        break;
                    }
                }

                if (!foundOrderGid || !foundSession) {
                    console.warn(`⚠️ Could not find order with proof_id: ${alanData.proof_id} in any connected store`);
                    return;
                }

                const session = foundSession;
                const orderGid = foundOrderGid;

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

                // --- END MULTI-TENANT SAFE SECTION ---
                    
                    const metafields = [
                        {
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "verification_status",
                            type: "single_line_text_field",
                            value: "verified",
                        },
                        {
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "gps_verdict",
                            type: "single_line_text_field",
                            value: alanData.gps_verdict || "unknown",
                        },
                        {
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "delivery_timestamp",
                            type: "single_line_text_field",
                            value: new Date().toISOString(),
                        },
                        {
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "device_info",
                            type: "single_line_text_field",
                            value: device_info || "Unknown Device",
                        }
                    ];

                    if (alanData.verify_url) {
                        metafields.push({
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "verify_url",
                            type: "single_line_text_field",
                            value: alanData.verify_url,
                        });
                    }

                    if (delivery_gps && delivery_gps.lat) {
                        metafields.push({
                            ownerId: orderGid,
                            namespace: "ink",
                            key: "delivery_gps",
                            type: "json",
                            value: JSON.stringify(delivery_gps),
                        });
                    }
                    
                    const mutation = `
                        mutation SetVerificationMetafields($metafields: [MetafieldsSetInput!]!) {
                            metafieldsSet(metafields: $metafields) {
                                userErrors { field message }
                            }
                        }
                    `;
                    
                    const metaResult = await adminGraphql(mutation, { metafields });
                    
                    if (metaResult.data?.metafieldsSet?.userErrors?.length > 0) {
                        console.error("⚠️ Metafield errors:", metaResult.data.metafieldsSet.userErrors);
                    } else {
                        console.log("✅ Metafields updated immediately via fallback");
                        console.log(`   - verification_status: verified`);
                        console.log(`   - gps_verdict: ${alanData.gps_verdict || "unknown"}`);
                    }
                
                console.log("📝 Fallback metafield update completed\n");
            } catch (fallbackError) {
                console.error("❌ Fallback metafield update failed:", fallbackError);
            }
        })();
        // =================================================================
        // END FALLBACK
        // =================================================================

        // =================================================================
        // TESTING MODE: Send email on EVERY scan
        // TODO: Remove this after testing - webhook should handle it in production
        // =================================================================
        (async () => {
            try {
                console.log("\n📧 =================================================");
                console.log("📧 Sending Return Passport Email");
                console.log("📧 =================================================");
                
                const { getOfflineSession } = await import("../session-utils.server");
                
                const session = await getOfflineSession();
                
                if (!session) {
                    console.warn("⚠️ No session found for email");
                    return;
                }
                
                // Get order_id and photos from alanData
                console.log("🔍 Using retrieved proof data for email...");
                const proofData = alanData;
                console.log("📦 Proof data:", proofData);
                
                let orderId = proofData.order_id;
                // Get photos from media_items logic
                const photoUrls = (proofData.media_items || []).map((m: any) => m.media_url || m.url);
                console.log("📦 Order ID from Alan:", orderId);
                console.log("📸 Photo URLs:", photoUrls);
                
                // Extract numeric part (without truncating to length 4)
                const numericOrderId = orderId ? String(orderId).replace(/\D/g, '') : '';
                console.log("🔢 Numeric Order ID Extracted:", numericOrderId);
                
                // Create admin GraphQL helper
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
                
                const queryFields = `
                  edges { 
                      node { 
                          id
                          name
                          customer { email firstName }
                          lineItems(first: 1) {
                              edges {
                                  node {
                                      image {
                                          url
                                      }
                                  }
                              }
                          }
                      } 
                  }
                `;

                // 1. First try by Proof ID (Deterministic)
                let searchResult = null;
                console.log(`🔍 Searching for order with proof_id: ${alanData.proof_id}`);
                const proofQuery = `#graphql
                    query SearchOrderByProof($query: String!) {
                        orders(first: 1, query: $query) {
                            ${queryFields}
                        }
                    }
                `;
                const proofResult = await adminGraphql(proofQuery, { 
                    query: `metafield.ink.proof_reference:${alanData.proof_id}` 
                });

                if (proofResult?.data?.orders?.edges?.length > 0) {
                    searchResult = proofResult;
                    console.log("✅ Found order via proof_reference");
                } 
                // 2. Fallback to direct GID
                else if (numericOrderId && numericOrderId.length > 10) {
                    const directQuery = `#graphql
                      query CheckOrder($id: ID!) {
                        order(id: $id) {
                          id
                          name
                          customer { email firstName }
                          lineItems(first: 1) {
                            edges { node { image { url } } }
                          }
                        }
                      }
                    `;
                    console.log("🔍 Trying direct ID search:", `gid://shopify/Order/${numericOrderId}`);
                    const checkResult = await adminGraphql(directQuery, { id: `gid://shopify/Order/${numericOrderId}` });
                    if (checkResult?.data?.order?.id) {
                        searchResult = { data: { orders: { edges: [ { node: checkResult.data.order } ] } } };
                        console.log("✅ Found order via direct ID");
                    }
                }

                // 3. Last resort fallback to Name (if orderId seems like a name)
                if (!searchResult && numericOrderId && numericOrderId.length <= 10) {
                    console.log("🔍 Trying name search with:", numericOrderId);
                    const nameQuery = `#graphql
                        query FindOrderByName($query: String!) {
                            orders(first: 1, query: $query) {
                                ${queryFields}
                            }
                        }
                    `;
                    searchResult = await adminGraphql(nameQuery, { query: `name:${numericOrderId}` });
                    if (!searchResult?.data?.orders?.edges?.length) {
                        searchResult = await adminGraphql(nameQuery, { query: `name:#${numericOrderId}` });
                    }
                }
                
                if (searchResult?.data?.orders?.edges?.length > 0) {
                    const order = searchResult.data.orders.edges[0].node;
                    console.log("✅ Found order:", order.name);
                    console.log("📧 Customer email:", order.customer?.email);
                    
                    const productImageUrl = order.lineItems?.edges?.[0]?.node?.image?.url;

                    if (order.customer?.email) {
                        const { EmailService } = await import("../services/email.server");
                        
                        // Fetch settings
                        const { default: firestore } = await import("../firestore.server");
                        let rWindow = 30;
                        try {
                            const settingsSnap = await firestore.collection("merchants").where("shopDomain", "==", session.shop).limit(1).get();
                            if (!settingsSnap.empty) {
                                const settings = settingsSnap.docs[0].data().notification_settings;
                                if (settings?.returnWindow) {
                                    rWindow = parseInt(settings.returnWindow) || 30;
                                }
                            }
                        } catch (e) {
                            console.warn("Could not fetch return window settings:", e);
                        }
                        
                        // Send Return Passport email with photos
                        await EmailService.sendReturnPassportEmail({
                            to: order.customer.email,
                            customerName: order.customer.firstName || "Customer",
                            orderName: order.name,
                            proofUrl: alanData.verify_url || `https://in.ink/verify/${alanData.proof_id}`,
                            photoUrls: photoUrls,
                            returnWindowDays: rWindow,
                            merchantName: session.shop.replace('.myshopify.com', ''),
                            productImageUrl: productImageUrl,
                        });
                        
                        console.log(`✅ Return Passport email sent to ${order.customer.email}`);
                    } else {
                        console.warn("⚠️ Order found but no customer email");
                    }
                } else {
                    console.warn(`⚠️ Could not find order #${numericOrderId}`);
                }
                
                
                console.log("📧 Return Passport email process completed\n");
            } catch (emailError) {
                console.error("❌ Return Passport email failed:", emailError);
            }
        })();

        // =================================================================
        // END TESTING MODE
        // =================================================================

        // Return Alan's response directly to frontend
        return new Response(JSON.stringify(alanData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("❌ Verify error:", error);
        
        if (error.message?.includes("Phone verification required")) {
            return new Response(
                JSON.stringify({ error: error.message }),
                { status: 403, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }
        
        if (error.message?.includes("Tag not enrolled")) {
            return new Response(
                JSON.stringify({ error: "Tag not enrolled. Please enroll this package first at the warehouse." }),
                { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }
        
        return new Response(
            JSON.stringify({ error: error.message || "Verification failed" }),
            { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
    }
};