import { type ActionFunctionArgs } from "react-router";
import { NFSService } from "../services/nfs.server";
import { INK_NAMESPACE } from "../utils/metafields.server";
import { serialNumberToToken } from "../utils/nfc-conversion.server";

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
  // We still need Prisma for Session table (Shopify OAuth)
  const { PrismaClient } = await import("@prisma/client");
  const prisma = new PrismaClient();

  try {
    // Get offline session (needed for Shopify API calls)
    const session = await prisma.session.findFirst({
      where: { isOnline: false },
    });

    if (!session) {
      await prisma.$disconnect();
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
    const { order_id, serial_number, photo_urls, photo_hashes, shipping_address_gps } = payload;

    console.log(`📦 Enrollment request for order ${order_id}, serial: ${serial_number}`);

    if (!order_id || !serial_number || !photo_urls || !photo_hashes) {
      console.error("❌ Missing required fields");
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ error: "Missing required fields: order_id, serial_number, photo_urls, photo_hashes" }),
        {
          status: 400,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // Convert serial number to UID and Token (deterministic)
    const { uid, token } = serialNumberToToken(serial_number);
    console.log(`✅ Converted serial to UID: ${uid}, Token: ${token.substring(0, 30)}...`);

    // Create admin client helper for Shopify API calls
    const admin = {
      graphql: async (query: string, options?: any) => {
        const response = await fetch(`https://${session.shop}/admin/api/2024-10/graphql.json`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Shopify-Access-Token": session.accessToken,
          },
          body: JSON.stringify({
            query,
            variables: options?.variables || {},
          }),
        });

        return {
          json: async () => await response.json(),
        };
      },
    };

    // 1. Fetch customer phone from Shopify order
    console.log(`📞 Fetching customer phone for order ${order_id}...`);
    let customer_phone_last4: string | undefined;

    try {
      const numericOrderId = order_id.replace(/\D/g, '');
      const orderGid = `gid://shopify/Order/${numericOrderId}`;

      const orderQuery = `
        query getOrder($id: ID!) {
          order(id: $id) {
            customer {
              phone
            }
          }
        }
      `;

      const orderResponse = await admin.graphql(orderQuery, { variables: { id: orderGid } });
      const orderData = await orderResponse.json();
      const customerPhone = orderData.data?.order?.customer?.phone;

      if (customerPhone) {
        // Extract last 4 digits (remove non-numeric characters)
        const phoneDigits = customerPhone.replace(/\D/g, '');
        customer_phone_last4 = phoneDigits.slice(-4);
        console.log(`✅ Customer phone last 4: ${customer_phone_last4}`);
      } else {
        console.warn("⚠️ No customer phone found for order");
      }
    } catch (phoneError) {
      console.error("Error fetching customer phone:", phoneError);
      // Continue enrollment even if phone fetch fails
    }

    // 2. Call Alan's NFS API to Enroll
    // Alan's API is the SINGLE SOURCE OF TRUTH - no local database save
    console.log("🚀 Calling Alan's NFS API /enroll...");
    
    const enrollPayload = {
      order_id,
      nfc_uid: serial_number,  // Send original serial number to Alan (e.g., "ef:8b:c4:c3")
      nfc_token: token,        // Send our deterministically generated token
      photo_urls,
      photo_hashes,
      shipping_address_gps,
      customer_phone_last4: customer_phone_last4 || "1234",  // Default if not available
      warehouse_gps: {
        lat: 40.7580,
        lng: -73.9855
      }
    };

    let nfsResponse;
    try {
      nfsResponse = await NFSService.enroll(enrollPayload);
      console.log(`✅ NFS enrollment successful: ${nfsResponse.proof_id}`);
    } catch (error: any) {
      console.error("❌ NFS enrollment failed:", error.message);
      await prisma.$disconnect();
      return new Response(
        JSON.stringify({ 
          error: "Enrollment failed", 
          details: error.message 
        }),
        {
          status: 500,
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
        }
      );
    }

    // 3. Update Shopify Metafields with proof_id for later retrieval
    // This is the ONLY place we store a reference to the proof
    console.log("📝 Updating order metafields...");
    try {
      const numericOrderId = order_id.replace(/\D/g, '');
      const orderGid = `gid://shopify/Order/${numericOrderId}`;

      const metafields = [
        {
          ownerId: orderGid,
          namespace: INK_NAMESPACE,
          key: "proof_reference",
          type: "single_line_text_field",
          value: nfsResponse.proof_id,  // Store Alan's proof_id for retrieval
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
          value: serial_number,  // Store original serial for reference
        },
      ];

      const mutation = `
        mutation SetEnrollmentMetafields($metafields: [MetafieldsSetInput!]!) {
          metafieldsSet(metafields: $metafields) {
            userErrors { field message }
          }
        }
      `;

      const metaResult = await admin.graphql(mutation, { variables: { metafields } });
      const metaData = await metaResult.json();
      
      if (metaData.data?.metafieldsSet?.userErrors?.length > 0) {
        console.warn("⚠️ Metafield errors:", metaData.data.metafieldsSet.userErrors);
      } else {
        console.log("✅ Metafields updated successfully");
      }
    } catch (metaError) {
      console.error("⚠️ Metafield update failed:", metaError);
      // Don't fail the request - enrollment is already saved in Alan's API
    }

    await prisma.$disconnect();

    // Return success with proof_id from Alan's API
    return new Response(
      JSON.stringify({
        success: true,
        proof_id: nfsResponse.proof_id,
        enrollment_status: nfsResponse.enrollment_status,
        key_id: nfsResponse.key_id,
      }),
      {
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );

  } catch (error: any) {
    console.error("❌ Enrollment Error:", error);
    await prisma.$disconnect();
    return new Response(
      JSON.stringify({ error: error.message || "Enrollment failed" }),
      {
        status: 500,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }
    );
  }
};