import { type ActionFunctionArgs } from "react-router";
import { serialNumberToToken } from "../utils/nfc-conversion.server";
import { NFSService } from "../services/nfs.server";

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
    console.log("🚨 Time:", new Date().toISOString());
    console.log("🚨 Method:", request.method);
    console.log("🚨 URL:", request.url);
    console.log("🚨 =================================================\n");

    try {
        const payload = await request.json();
        console.log("📥 Raw payload received:", JSON.stringify(payload, null, 2));

        const { serial_number, delivery_gps, device_info, phone_last4 } = payload;

        console.log("📍 Verify request received:", { serial_number, delivery_gps, device_info, phone_last4 });

        if (!serial_number || !delivery_gps) {
            console.error("❌ Validation failed: Missing serial_number or delivery_gps");
            return new Response(
                JSON.stringify({ error: "Missing required fields: serial_number and delivery_gps" }),
                { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        // DETERMINISTIC: Compute token directly from serial number
        // No database lookup needed - same serial ALWAYS produces same token
        const { uid, token } = serialNumberToToken(serial_number);
        console.log(`✅ Computed from serial: UID="${uid}", Token="${token.substring(0, 20)}..."`);

        // Call Alan's API directly using the computed token
        // Alan's API is the SINGLE SOURCE OF TRUTH
        console.log("🚀 Calling Alan's NFS API /verify...");
        
        const alanData = await NFSService.verify({
            nfc_token: token,
            delivery_gps,
            device_info: device_info || "Unknown",
            phone_last4: phone_last4,
        });

        console.log("✅ Alan's server response:", alanData);

        // Return Alan's response directly to frontend
        // NO local database save - Alan's API is the single source of truth
        return new Response(JSON.stringify(alanData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("❌ Verify error:", error);
        
        // Handle specific error types
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