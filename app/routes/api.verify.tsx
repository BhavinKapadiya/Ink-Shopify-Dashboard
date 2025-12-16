import { type ActionFunctionArgs } from "react-router";
import { serialNumberToToken } from "../utils/nfc-conversion.server";
import { NFSService } from "../services/nfs.server";
import { EmailService } from "../services/email.server";
import { INK_NAMESPACE } from "../utils/metafields.server";

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
        console.log("🚀 Calling Alan's NFS API /verify...");
        
        const alanData = await NFSService.verify({
            nfc_token: token,
            delivery_gps,
            device_info: device_info || "Unknown",
            phone_last4: phone_last4,
        });

        console.log("✅ Alan's server response:", alanData);

        // =================================================================
        // TESTING MODE: Send email on EVERY scan
        // TODO: Remove this after testing - webhook should handle it in production
        // =================================================================
        (async () => {
            try {
                console.log("\n📧 ================================================");
                console.log("📧 TESTING MODE: Email on every scan");
                console.log("📧 ================================================");
                
                const { PrismaClient } = await import("@prisma/client");
                const prisma = new PrismaClient();
                
                const session = await prisma.session.findFirst({ where: { isOnline: false } });
                
                if (!session) {
                    console.warn("⚠️ No session found for email");
                    await prisma.$disconnect();
                    return;
                }
                
                // Get order_id from Alan's retrieve API
                console.log("🔍 Retrieving proof from Alan to get order_id...");
                const proofData = await NFSService.retrieveProof(alanData.proof_id);
                console.log("📦 Proof data:", proofData);
                
                let orderId = proofData.order_id;
                console.log("📦 Order ID from Alan:", orderId);
                
                // Extract numeric part (handles both "1015" and "1015***015" formats)
                const numericOrderId = orderId.replace(/\D/g, '').substring(0, 4); // Get first 4 digits
                console.log("🔢 Numeric Order ID:", numericOrderId);
                
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
                
                // Try to find order by name (order number)
                let orderGid = `gid://shopify/Order/${numericOrderId}`;
                
                const nameQuery = `#graphql
                    query FindOrderByName($query: String!) {
                        orders(first: 1, query: $query) {
                            edges { 
                                node { 
                                    id
                                    name
                                    customer { email firstName }
                                } 
                            }
                        }
                    }
                `;
                
                console.log("🔍 Searching for order by name:", numericOrderId);
                let searchResult = await adminGraphql(nameQuery, { query: `name:${numericOrderId}` });
                
                if (!searchResult?.data?.orders?.edges?.length) {
                    console.log("🔍 Trying with # prefix...");
                    searchResult = await adminGraphql(nameQuery, { query: `name:#${numericOrderId}` });
                }
                
                if (searchResult?.data?.orders?.edges?.length > 0) {
                    const order = searchResult.data.orders.edges[0].node;
                    console.log("✅ Found order:", order.name);
                    console.log("📧 Customer email:", order.customer?.email);
                    
                    if (order.customer?.email) {
                        const { EmailService } = await import("../services/email.server");
                        
                        await EmailService.sendVerificationEmail({
                            to: order.customer.email,
                            customerName: order.customer.firstName || "Customer",
                            orderName: order.name,
                            proofUrl: alanData.verify_url || `https://in.ink/verify/${alanData.proof_id}`,
                        });
                        
                        console.log(`✅ TESTING MODE: Email sent to ${order.customer.email}`);
                    } else {
                        console.warn("⚠️ Order found but no customer email");
                    }
                } else {
                    console.warn(`⚠️ Could not find order #${numericOrderId}`);
                }
                
                await prisma.$disconnect();
                console.log("📧 Testing mode email process completed\n");
            } catch (emailError) {
                console.error("❌ Testing mode email failed:", emailError);
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