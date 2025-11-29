import { type LoaderFunctionArgs } from "react-router";

const CORS_HEADERS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, Accept, X-Requested-With, Origin",
};

// Handle OPTIONS preflight
export const action = async () => {
    return new Response(null, {
        status: 204,
        headers: CORS_HEADERS,
    });
};

export const loader = async ({ params }: LoaderFunctionArgs) => {
    console.log("\n🔍 =================================================");
    console.log("🔍 /api/retrieve ENDPOINT HIT");
    console.log("🔍 Time:", new Date().toISOString());
    console.log("🔍 Proof ID:", params.proofId);
    console.log("🔍 =================================================\n");

    const { proofId } = params;

    if (!proofId) {
        return new Response(
            JSON.stringify({ error: "Missing proof_id" }),
            { status: 400, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
    }

    try {
        // Simply proxy the request to Alan's server
        const NFS_API_URL = process.env.NFS_API_URL || "https://us-central1-inink-c76d3.cloudfunctions.net/api";
        const alanUrl = `${NFS_API_URL}/retrieve/${proofId}`;

        console.log(`🚀 Proxying to Alan's server: ${alanUrl}`);

        const alanResponse = await fetch(alanUrl, {
            method: "GET",
        });

        if (!alanResponse.ok) {
            const errorText = await alanResponse.text();
            console.error("❌ Alan's server error:", errorText);
            return new Response(
                JSON.stringify({ error: `Retrieve service error: ${errorText}` }),
                { status: alanResponse.status, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }

        const alanData = await alanResponse.json();
        console.log("✅ Alan's server response received");

        // Return Alan's response with CORS headers
        return new Response(JSON.stringify(alanData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("❌ Retrieve error:", error);
        return new Response(
            JSON.stringify({ error: error.message || "Retrieve failed" }),
            { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
    }
};