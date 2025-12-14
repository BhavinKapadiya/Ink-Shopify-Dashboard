import { type LoaderFunctionArgs } from "react-router";
import { NFSService } from "../services/nfs.server";

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
        // Call Alan's API directly - it's the single source of truth
        console.log(`🚀 Calling Alan's NFS API /retrieve/${proofId}...`);
        
        const proofData = await NFSService.retrieveProof(proofId);
        console.log("✅ Proof data retrieved from Alan's API");

        // Return Alan's response with CORS headers
        return new Response(JSON.stringify(proofData), {
            headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
        });

    } catch (error: any) {
        console.error("❌ Retrieve error:", error);
        
        if (error.message?.includes("Proof not found")) {
            return new Response(
                JSON.stringify({ error: "Proof not found" }),
                { status: 404, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
            );
        }
        
        return new Response(
            JSON.stringify({ error: error.message || "Retrieve failed" }),
            { status: 500, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } }
        );
    }
};