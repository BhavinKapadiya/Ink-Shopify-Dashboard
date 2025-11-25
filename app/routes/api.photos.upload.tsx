import { type ActionFunctionArgs } from "react-router";
import { restResources } from "@shopify/shopify-api/rest/admin/2024-10";
import { getStagedUploadTarget, registerUploadedFile } from "../utils/shopify-files.server";
import { generateSHA256Hash } from "../utils/hash-utils.server";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};

// Handle OPTIONS preflight request
export const loader = async () => {
  return new Response(null, {
    status: 204,
    headers: CORS_HEADERS,
  });
};

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    // Get offline session for API access
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

    // Import shopify and create GraphQL client
    const shopifyModule = await import("../shopify.server");
    const shopify = shopifyModule.default;
    
    // @ts-ignore - shopify object has api property
    const admin = new shopify.api.clients.Graphql({ session });
    
    const formData = await request.formData();
    const orderId = formData.get("orderId") as string;
    const photo = formData.get("photo") as File;
    const photoIndex = formData.get("photoIndex") as string;

    if (!photo || !orderId) {
      return new Response(
        JSON.stringify({ error: "Missing photo or orderId" }), 
        { 
          status: 400, 
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
        }
      );
    }

    // 1. Get staged upload target
    const target = await getStagedUploadTarget(admin, {
      filename: photo.name || `photo_${photoIndex}.jpg`,
      mimeType: photo.type || "image/jpeg",
      resource: "IMAGE",
      fileSize: photo.size.toString(),
    });

    // 2. Upload to Shopify's staged URL
    const uploadFormData = new FormData();
    target.parameters.forEach((p: any) => uploadFormData.append(p.name, p.value));
    uploadFormData.append("file", photo);

    const uploadResponse = await fetch(target.url, {
      method: "POST",
      body: uploadFormData,
    });

    if (!uploadResponse.ok) {
      return new Response(
        JSON.stringify({ error: "Upload to Shopify failed", status: uploadResponse.status }), 
        { 
          status: 500, 
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
        }
      );
    }

    // 3. Register the uploaded file
    const registeredFile = await registerUploadedFile(admin, target.resourceUrl);
    const fileUrl = registeredFile?.url || "";

    if (!fileUrl) {
      return new Response(
        JSON.stringify({ error: "Failed to register file" }), 
        { 
          status: 500, 
          headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
        }
      );
    }

    // 4. Generate SHA-256 hash
    const arrayBuffer = await photo.arrayBuffer();
    const photoHash = await generateSHA256Hash(Buffer.from(arrayBuffer));

    await prisma.$disconnect();

    return new Response(
      JSON.stringify({ 
        success: true, 
        photoUrl: fileUrl, 
        photoHash,
        photoIndex: Number(photoIndex)
      }), 
      { 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }
    );

  } catch (error: any) {
    console.error("Photo upload error:", error);
    return new Response(
      JSON.stringify({ error: error.message || "Upload failed" }), 
      { 
        status: 500, 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }
    );
  }
};
