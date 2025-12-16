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

        // ---------------------------------------------------------
        // SEND EMAIL NOTIFICATION (Fire & Forget)
        // ---------------------------------------------------------
        (async () => {
            try {
                console.log("📧 Starting email notification process...");
                const { PrismaClient } = await import("@prisma/client");
                const prisma = new PrismaClient();
                
                const session = await prisma.session.findFirst({ where: { isOnline: false } });
                
                if (session) {
                    // Find order by Proof Reference (returned by Alan)
                    // This is safer than searching by 'nfc_uid' which has colons
                    const proofId = alanData.proof_id;

                    console.log(`🔍 Searching for order with proof_reference: ${proofId}`);
                    
                    const query = `#graphql
                        query FindOrderByMetafield {
                            orders(first: 1, query: "metafield:${INK_NAMESPACE}.proof_reference:'${proofId}'") {
                                edges {
                                    node {
                                        id
                                        name
                                        customer {
                                            email
                                            firstName
                                        }
                                    }
                                }
                            }
                        }
                    `;
                    
                    const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
                        method: "POST",
                        headers: {
                            "Content-Type": "application/json",
                            "X-Shopify-Access-Token": session.accessToken,
                        },
                        body: JSON.stringify({ query }),
                    });
                    
                    const result = await response.json();
                    const orderNode = result.data?.orders?.edges?.[0]?.node;

                    if (orderNode) {
                        console.log(`✅ Found order for email: ${orderNode.name} (${orderNode.customer?.email || "No Email"})`);
                        
                        if (orderNode.customer?.email) {
                            await EmailService.sendVerificationEmail({
                                to: orderNode.customer.email,
                                customerName: orderNode.customer.firstName || "Customer",
                                orderName: orderNode.name,
                                proofUrl: alanData.verify_url || `https://in.ink/verify/${alanData.proof_id}`,
                            });
                        }
                    } else {
                        console.warn(`⚠️ Could not find order linked to proof ${proofId}. Search returned no results.`);
                    }
                }
                
                await prisma.$disconnect();
            } catch (emailError) {
                console.error("❌ Failed to send verification email:", emailError);
            }
        })();

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