import { type ActionFunctionArgs } from "react-router";
import { serialNumberToUID } from "../utils/nfc-conversion.server";

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

    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    try {
        const payload = await request.json();
        console.log("📥 Raw payload received:", JSON.stringify(payload, null, 2));

        const { serial_number, delivery_gps, device_info, phone_last4 } = payload;

        console.log("📍 Verify request received:", { serial_number, delivery_gps, device_info, phone_last4 });

        if (!serial_number || !delivery_gps) {
            console.error("❌ Validation failed: Missing serial_number or delivery_gps");
            await prisma.$disconnect();
            return new Response(
                JSON.stringify({ error: "Missing required fields: serial_number and delivery_gps" }),
                { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        // Convert serial number to UID (deterministic)
        const uid = serialNumberToUID(serial_number);
        console.log(`✅ Converted serial to UID: ${uid}`);

        // Lookup proof by UID in database
        console.log("🔍 Looking up proof by UID:", uid);
        const proof = await prisma.proof.findFirst({
            where: { nfc_uid: uid },
        });

        if (!proof) {
            console.error("❌ UID not found in database:", uid);
            await prisma.$disconnect();
            return new Response(
                JSON.stringify({ error: "Tag not enrolled. Please enroll this package first at the warehouse." }),
                { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        console.log("✅ Proof found:", { proof_id: proof.proof_id, order_id: proof.order_id, token: proof.nfc_token });

        // Call Alan's server /verify endpoint with the token from database
        // ALL fields MUST be present per Alan's API requirements
        const NFS_API_URL = process.env.NFS_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
        const alanPayload = {
            nfc_token: proof.nfc_token,  // Use token from database (required)
            delivery_gps,  // Required
            device_info: device_info || "Unknown",  // Default if not provided
            phone_last4: phone_last4 || "1234",  // Default if not provided
        };

        console.log("🚀 Calling Alan's server /verify:", `${NFS_API_URL}/verify`);
        const alanResponse = await fetch(`${NFS_API_URL}/verify`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(alanPayload),
        });

        if (!alanResponse.ok) {
            const errorText = await alanResponse.text();
            console.error("❌ Alan's server error:", errorText);
            await prisma.$disconnect();
            return new Response(
                JSON.stringify({ error: `Verification service error: ${errorText}` }),
                { status: alanResponse.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        const alanData = await alanResponse.json();
        console.log("✅ Alan's server response:", alanData);

        // Check if verification data already exists
        const hasExistingVerification = proof.verification_status !== null;

        if (hasExistingVerification) {
            console.log("📝 Updating existing verification data with new timestamp...");
            console.log(`   Previous verification status: ${proof.verification_status}`);
        } else {
            console.log("🆕 Adding new verification data...");
        }

        // Update local database with ALL verification info from Alan's response
        console.log("💾 Saving verification data to local database...");
        await prisma.proof.update({
            where: { proof_id: proof.proof_id },
            data: {
                // Your delivery data (fields you control)
                delivery_timestamp: new Date(),
                delivery_gps: JSON.stringify(delivery_gps),
                device_info: device_info || "Unknown",
                phone_verified: !!phone_last4,

                // Alan's API response data (fields from external API)
                verification_status: alanData.status || alanData.verification_status,
                gps_verdict: alanData.gps_verdict,
                distance_meters: alanData.distance_meters ? parseFloat(alanData.distance_meters) : null,
                signature: alanData.signature,
                verify_url: alanData.verify_url,
                nfs_proof_id: alanData.proof_id || proof.nfs_proof_id, // Keep existing if not in response

                // Timestamp for when Alan's verification data was last updated
                verification_updated_at: new Date(),
            },
        });

        console.log(hasExistingVerification
            ? "✅ Verification data updated with new timestamp"
            : "✅ New verification data saved to local database"
        );

        await prisma.$disconnect();

        // Return Alan's response to frontend
        return new Response(JSON.stringify(alanData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("❌ Verify error:", error);
        await prisma.$disconnect();
        return new Response(
            JSON.stringify({ error: error.message || "Verification failed" }),
            { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
    }
};