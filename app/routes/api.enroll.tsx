import { type ActionFunctionArgs } from "react-router";
import { NFSService } from "../services/nfs.server";
import { INK_NAMESPACE } from "../utils/metafields.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle OPTIONS preflight
export const loader = async () => {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    // Get offline session
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();
    
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
    });

    if (!session) {
      return new Response(
        JSON.stringify({ error: "No session available" }), 
        { 
          status: 500, 
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
        }
      );
    }

    // Parse JSON payload
    const payload = await request.json();
    const { order_id, nfc_uid, nfc_token, photo_urls, photo_hashes, shipping_address_gps } = payload;
    
    if (!order_id || !nfc_uid || !nfc_token) {
      return new Response(
        JSON.stringify({ error: "Missing required fields" }), 
        { 
          status: 400, 
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
        }
      );
    }

    // 1. Call NFS Backend to Enroll
    const enrollPayload = {
      order_id,
      nfc_uid,
      nfc_token,
      photo_urls,
      photo_hashes,
      shipping_address_gps,
    };

    const nfsResponse = await NFSService.enroll(enrollPayload);

    // 2. Update Shopify Metafields with Proof ID
    const shopifyModule = await import("../shopify.server");
    const shopify = shopifyModule.default;
    // @ts-ignore
    const admin = new shopify.api.clients.Graphql({ session });
    
    const numericOrderId = order_id.replace(/\D/g, '');
    const orderGid = `gid://shopify/Order/${numericOrderId}`;
    
    const metafields = [
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "proof_reference",
        type: "single_line_text_field",
        value: nfsResponse.proof_id,
      },
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "verification_status",
        type: "single_line_text_field",
        value: "enrolled",
      },
      {
        ownerId: orderGid,
        namespace: INK_NAMESPACE,
        key: "nfc_uid",
        type: "single_line_text_field",
        value: nfc_uid,
      },
    ];

    const mutation = `
      mutation SetEnrollmentMetafields($metafields: [MetafieldsSetInput!]!) {
        metafieldsSet(metafields: $metafields) {
          userErrors { field message }
        }
      }
    `;

    await admin.request(mutation, { variables: { metafields } });
    await prisma.$disconnect();

    return new Response(
      JSON.stringify({ success: true, proof_id: nfsResponse.proof_id }), 
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );

  } catch (error: any) {
    console.error("Enrollment Error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Enrollment failed" }), 
      { 
        status: 500, 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }
    );
  }
};
