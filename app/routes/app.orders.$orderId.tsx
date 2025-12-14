import { useEffect, useState } from "react";
import { data } from "react-router";
import {
    useLoaderData,
    useActionData,
    useNavigate,
    useRouteError,
    useFetcher,
} from "react-router";
import type {
    LoaderFunctionArgs,
    ActionFunctionArgs,
    HeadersFunction,
} from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
    Page,
    Layout,
    Card,
    BlockStack,
    Text,
    Thumbnail,
    Button,
    Banner,
    InlineStack,
    Badge,
    Grid,
    Divider,
    Spinner,
} from "@shopify/polaris";
import {
    getStagedUploadTarget,
    registerUploadedFile,
} from "../utils/shopify-files.server";

// Local interface for Proof since Prisma export is failing
interface Proof {
    order_id: string;
    enrollment_status: string | null;
    nfc_uid: string | null;
    nfs_proof_id: string | null;
    nfc_token: string | null;
    photo_hashes: string | null;
    delivery_gps: string | null;
    shipping_address_gps: string | null;
    proof_id: string;

    // Alan's API verification response fields
    verification_status: string | null;
    verify_url: string | null;
    verification_updated_at: Date | null;
    distance_meters: number | null;
    gps_verdict: string | null;
}

// Helper: Format Date
const formatDate = (dateString: string) => {
    return new Date(dateString).toLocaleDateString("en-US", {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "numeric",
    });
};

// Helper: Format GPS
const formatGPS = (gpsString: string | null) => {
    if (!gpsString) return null;
    try {
        // Handle both JSON format {"lat":...,"lng":...} and simple "lat,lng" string
        let lat, lng;
        if (gpsString.startsWith("{")) {
            const parsed = JSON.parse(gpsString);
            lat = parsed.lat;
            lng = parsed.lng;
        } else {
            [lat, lng] = gpsString.split(",");
        }

        if (!lat || !lng) return { text: gpsString, url: null };

        return {
            text: `${parseFloat(lat).toFixed(4)}, ${parseFloat(lng).toFixed(4)}`,
            url: `https://www.google.com/maps/search/?api=1&query=${lat},${lng}`
        };
    } catch (e) {
        return { text: gpsString, url: null };
    }
};

// Helper: Client-side Image Compression
const compressImage = async (file: File): Promise<File> => {
    return new Promise((resolve, reject) => {
        const maxWidth = 1280;
        const maxHeight = 1280;
        const quality = 0.7;

        const reader = new FileReader();
        reader.readAsDataURL(file);
        reader.onload = (event) => {
            const img = new Image();
            img.src = event.target?.result as string;
            img.onload = () => {
                let width = img.width;
                let height = img.height;

                if (width > maxWidth || height > maxHeight) {
                    if (width > height) {
                        height = Math.round((height * maxWidth) / width);
                        width = maxWidth;
                    } else {
                        width = Math.round((width * maxHeight) / height);
                        height = maxHeight;
                    }
                }

                const canvas = document.createElement("canvas");
                canvas.width = width;
                canvas.height = height;
                const ctx = canvas.getContext("2d");
                if (!ctx) {
                    reject(new Error("Could not get canvas context"));
                    return;
                }
                ctx.drawImage(img, 0, 0, width, height);

                canvas.toBlob(
                    (blob) => {
                        if (!blob) {
                            reject(new Error("Compression failed"));
                            return;
                        }
                        const compressedFile = new File([blob], file.name, {
                            type: "image/jpeg",
                            lastModified: Date.now(),
                        });
                        resolve(compressedFile);
                    },
                    "image/jpeg",
                    quality
                );
            };
            img.onerror = (err) => reject(err);
        };
        reader.onerror = (err) => reject(err);
    });
};

interface Product {
    title: string;
    quantity: number;
    price: string;
    sku: string;
    image: string | null;
}

interface OrderDetail {
    id: string;
    name: string;
    createdAt: string;
    financialStatus: string;
    fulfillmentStatus: string;
    totalPrice: string;
    currency: string;
    customerName: string;
    customerEmail: string;
    customerPhone: string;
    shippingAddress:
    | {
        address1: string;
        address2: string;
        city: string;
        province: string;
        zip: string;
        country: string;
    }
    | null;
    products: Product[];
    metafields: {
        verification_status?: string;
        nfc_uid?: string;
        proof_reference?: string;
        photos_hashes?: string;
        delivery_gps?: string;
        photo_urls?: string;
    };
    localProof?: {
        verification_status: string | null;
        verify_url: string | null;
        verification_updated_at: string | null;
        distance_meters: number | null;
        gps_verdict: string | null;
    } | null;
}

type LoaderData = {
    order: OrderDetail | null;
    error: string | null;
};

type ActionData = {
    success: boolean;
    message: string | null;
    fileUrl?: string;
    photoIndex?: number;
};

// ===== LOADER =====
export const loader = async ({
    request,
    params,
}: LoaderFunctionArgs): Promise<LoaderData> => {
    const { admin } = await authenticate.admin(request);
    const { orderId } = params;

    if (!orderId) {
        return { order: null, error: "Order ID is required" };
    }

    const query = `#graphql
    query GetOrderDetail($id: ID!) {
      order(id: $id) {
        id
        name
        createdAt
        displayFinancialStatus
        displayFulfillmentStatus
        totalPriceSet {
          shopMoney {
            amount
            currencyCode
          }
        }
        customer {
          firstName
          lastName
          email
          phone
        }
        shippingAddress {
          address1
          address2
          city
          province
          zip
          country
        }
        lineItems(first: 10) {
          edges {
            node {
              title
              quantity
              originalUnitPriceSet {
                shopMoney {
                  amount
                }
              }
              sku
              image {
                url
              }
            }
          }
        }
        metafields(namespace: "ink", first: 10) {
          edges {
            node {
              key
              value
            }
          }
        }
      }
    }`;

    try {
        const response = await admin.graphql(query, {
            variables: { id: `gid://shopify/Order/${orderId}` },
        });
        const result = await response.json();

        if (!result.data?.order) {
            return { order: null, error: "Order not found" };
        }

        const orderData = result.data.order;

        // Extract metafields from Shopify
        const metafields: OrderDetail["metafields"] = {};
        orderData.metafields.edges.forEach((edge: any) => {
            metafields[edge.node.key as keyof OrderDetail["metafields"]] =
                edge.node.value;
        });

        // Get proof_id from metafields (stored during enrollment)
        const proofId = metafields.proof_reference;
        console.log(`🔍 Order Details Loader: Order ${orderId}, Proof ID from metafields: ${proofId || "none"}`);

        // Fetch proof data from Alan's API if we have a proof_id
        let alanProofData: {
            verification_status: string | null;
            verify_url: string | null;
            verification_updated_at: string | null;
            distance_meters: number | null;
            gps_verdict: string | null;
            enrollment_status: string | null;
            nfc_uid: string | null;
            shipping_gps: string | null;
            delivery_gps: string | null;
            photo_urls: string[] | null;
        } | null = null;

        if (proofId) {
            try {
                // Import NFSService to call Alan's API
                const { NFSService } = await import("../services/nfs.server");
                const proofResponse = await NFSService.retrieveProof(proofId);
                
                console.log(`✅ Proof data retrieved from Alan's API`);
                
                alanProofData = {
                    verification_status: proofResponse.delivery?.gps_verdict ? "verified" : "enrolled",
                    verify_url: `https://in.ink/verify/${proofId}`,
                    verification_updated_at: proofResponse.delivery?.timestamp || null,
                    distance_meters: null, // Not returned by /retrieve, only /verify
                    gps_verdict: proofResponse.delivery?.gps_verdict || null,
                    enrollment_status: "enrolled",
                    nfc_uid: null, // Not returned in retrieve response
                    shipping_gps: proofResponse.enrollment?.shipping_address_gps 
                        ? JSON.stringify(proofResponse.enrollment.shipping_address_gps) 
                        : null,
                    delivery_gps: proofResponse.delivery?.delivery_gps 
                        ? JSON.stringify(proofResponse.delivery.delivery_gps) 
                        : null,
                    photo_urls: proofResponse.enrollment?.photo_urls || null,
                };
            } catch (alanError: any) {
                console.error(`⚠️ Failed to fetch proof from Alan's API:`, alanError.message);
                // Continue without proof data - don't fail the whole page
            }
        }

        // Determine normalized display status
        let displayStatus = "Pending";
        if (alanProofData?.verification_status === "verified") {
            displayStatus = "Verified";
        } else if (alanProofData?.enrollment_status === "enrolled" || metafields.verification_status === "enrolled") {
            displayStatus = "Enrolled";
        }

        metafields.verification_status = displayStatus;

        // Use data from Alan's API if available, otherwise fall back to metafields
        if (alanProofData) {
            metafields.nfc_uid = metafields.nfc_uid || alanProofData.nfc_uid || undefined;
            metafields.delivery_gps = alanProofData.delivery_gps || alanProofData.shipping_gps || metafields.delivery_gps;
        }

        // Extract products
        const products: Product[] = orderData.lineItems.edges.map((edge: any) => ({
            title: edge.node.title,
            quantity: edge.node.quantity,
            price: edge.node.originalUnitPriceSet.shopMoney.amount,
            sku: edge.node.sku || "N/A",
            image: edge.node.image?.url || null,
        }));

        const order: OrderDetail = {
            id: orderId,
            name: orderData.name,
            createdAt: orderData.createdAt,
            financialStatus: orderData.displayFinancialStatus,
            fulfillmentStatus: orderData.displayFulfillmentStatus,
            totalPrice: orderData.totalPriceSet.shopMoney.amount,
            currency: orderData.totalPriceSet.shopMoney.currencyCode,
            customerName: orderData.customer
                ? `${orderData.customer.firstName} ${orderData.customer.lastName}`
                : "Guest",
            customerEmail: orderData.customer?.email || "",
            customerPhone: orderData.customer?.phone || "",
            shippingAddress: orderData.shippingAddress || null,
            products,
            metafields,
            // Use Alan's API data for localProof (renamed but same structure)
            localProof: alanProofData ? {
                verification_status: alanProofData.verification_status,
                verify_url: alanProofData.verify_url,
                verification_updated_at: alanProofData.verification_updated_at,
                distance_meters: alanProofData.distance_meters,
                gps_verdict: alanProofData.gps_verdict,
            } : null,
        };

        return { order, error: null };
    } catch (error) {
        console.error("Loader error:", error);
        return { order: null, error: "Failed to load order" };
    }
};

// ===== ACTION =====
export const action = async ({ request, params }: ActionFunctionArgs) => {
    const { orderId } = params;

    try {
        const { admin } = await authenticate.admin(request);

        if (!orderId) {
            return data<ActionData>({
                success: false,
                message: "Order ID is required",
            });
        }

        const formData = await request.formData();
        const file = formData.get("photo") as any;
        const gpsData = (formData.get("gps") as string) || "";
        const photoIndexRaw = formData.get("photoIndex") as string | null;
        const photoIndex =
            photoIndexRaw != null ? Number(photoIndexRaw) : undefined;

        if (!file) {
            return data<ActionData>({
                success: false,
                message: "No file uploaded",
                photoIndex,
            });
        }

        const filename = (file as any).name || "upload.jpg";
        const mimeType = (file as any).type || "image/jpeg";
        const fileSize =
            typeof (file as any).size === "number"
                ? String((file as any).size)
                : "0";

        // 1. Get staged upload target from Shopify
        const target = await getStagedUploadTarget(admin, {
            filename,
            mimeType,
            resource: "IMAGE",
            fileSize,
        });

        // 2. Upload binary to the staged URL (server-side)
        const uploadFormData = new FormData();
        target.parameters.forEach((p: any) =>
            uploadFormData.append(p.name, p.value)
        );
        uploadFormData.append("file", file);

        const uploadResponse = await fetch(target.url, {
            method: "POST",
            body: uploadFormData,
        });

        if (!uploadResponse.ok) {
            console.error("Staged upload failed:", await uploadResponse.text());
            return data<ActionData>({
                success: false,
                message: "Failed to upload file to storage",
                photoIndex,
            });
        }

        // 3. Register the file in Shopify Files API
        let fileUrl = "";
        try {
            const registered = await registerUploadedFile(admin, target.resourceUrl);
            // URL might be null/undefined while the file is still processing.
            // That's OK – registration itself succeeded if no error was thrown.
            fileUrl = registered?.url || "";
        } catch (e: any) {
            console.error("registerUploadedFile error:", e);
            return data<ActionData>({
                success: false,
                message:
                    e?.message || "Failed to register uploaded file with Shopify Files",
                photoIndex,
            });
        }

        // 4. Update metafields (delivery_gps) ONLY IF we actually have GPS data
        if (gpsData) {
            const metafieldsSet = [
                {
                    namespace: "ink",
                    key: "delivery_gps",
                    value: gpsData,
                    type: "single_line_text_field",
                },
            ];

            const mfResponse = await admin.graphql(
                `#graphql
          mutation metaobjectUpsert($metafields: [MetafieldsSetInput!]!) {
            metafieldsSet(metafields: $metafields) {
              userErrors {
                field
                message
              }
            }
          }`,
                {
                    variables: {
                        metafields: metafieldsSet.map((m) => ({
                            ...m,
                            ownerId: `gid://shopify/Order/${orderId}`,
                        })),
                    },
                }
            );

            const mfJson = await mfResponse.json();
            const errors = mfJson?.data?.metafieldsSet?.userErrors || [];
            if (errors.length) {
                console.error("Metafields errors:", errors);
                return data<ActionData>({
                    success: false,
                    message: errors.map((e: any) => e.message).join(", "),
                    photoIndex,
                });
            }
        }

        // If no GPS data, we just skip metafieldsSet and still treat upload as success
        return data<ActionData>({
            success: true,
            message: "File uploaded successfully",
            fileUrl,
            photoIndex,
        });
    } catch (error: any) {
        console.error("Upload error:", error);
        return data<ActionData>({
            success: false,
            message: error.message || "Upload failed",
        });
    }
};

export default function OrderDetails() {
    const { order, error } = useLoaderData() as LoaderData;
    const actionData = useActionData() as ActionData | undefined;
    const navigate = useNavigate();

    // Per-photo UI state
    const [photos, setPhotos] = useState<(File | null)[]>([
        null,
        null,
        null,
        null,
    ]);
    const [photoPreviews, setPhotoPreviews] = useState<(string | null)[]>([
        null,
        null,
        null,
        null,
    ]);
    const [uploadStatus, setUploadStatus] = useState<
        ("idle" | "uploading" | "success" | "error")[]
    >(["idle", "idle", "idle", "idle"]);
    const [uploadProgress, setUploadProgress] = useState<number[]>([
        0, 0, 0, 0,
    ]);
    const [uploadingIndex, setUploadingIndex] = useState<number | null>(null);

    // Single fetcher used for upload; server returns ActionData
    const uploadFetcher = useFetcher<ActionData>();

    // React to server action completion
    useEffect(() => {
        if (uploadFetcher.state === "idle" && uploadFetcher.data) {
            const { success, message, photoIndex } = uploadFetcher.data;

            if (typeof photoIndex === "number") {
                const idx = photoIndex;
                setUploadingIndex(null);

                setUploadProgress((prev) => {
                    const next = [...prev];
                    next[idx] = success ? 100 : 0;
                    return next;
                });

                setUploadStatus((prev) => {
                    const next = [...prev];
                    next[idx] = success ? "success" : "error";
                    return next;
                });

                if (!success && message) {
                    alert(`❌ ${message}`);
                }
            }
        }
    }, [uploadFetcher.state, uploadFetcher.data]);

    if (error || !order) {
        return (
            <Page>
                <Banner tone="critical">{error || "Order not found"}</Banner>
            </Page>
        );
    }

    const handleFileSelect = (index: number, file: File | null) => {
        if (!file) return;

        if (!file.type.startsWith("image/")) {
            alert("Please select an image file");
            return;
        }

        if (file.size > 5 * 1024 * 1024) {
            alert("File size must be less than 5MB");
            return;
        }

        const newPhotos = [...photos];
        newPhotos[index] = file;
        setPhotos(newPhotos);

        const reader = new FileReader();
        reader.onloadend = () => {
            const newPreviews = [...photoPreviews];
            newPreviews[index] = reader.result as string;
            setPhotoPreviews(newPreviews);
        };
        reader.readAsDataURL(file);
    };

    const handleRemovePhoto = (index: number) => {
        const newPhotos = [...photos];
        newPhotos[index] = null;
        setPhotos(newPhotos);

        const newPreviews = [...photoPreviews];
        newPreviews[index] = null;
        setPhotoPreviews(newPreviews);

        const newStatus = [...uploadStatus];
        newStatus[index] = "idle";
        setUploadStatus(newStatus);

        const newProgress = [...uploadProgress];
        newProgress[index] = 0;
        setUploadProgress(newProgress);
    };

    const handleUploadPhoto = async (index: number) => {
        const originalPhoto = photos[index];
        if (!originalPhoto) return;

        setUploadingIndex(index);
        setUploadStatus((prev) => {
            const next = [...prev];
            next[index] = "uploading";
            return next;
        });
        setUploadProgress((prev) => {
            const next = [...prev];
            next[index] = 10; // initial
            return next;
        });

        // Compress the image
        let photo: File;
        try {
            photo = await compressImage(originalPhoto);
            console.log(`Compressed: ${originalPhoto.size} -> ${photo.size}`);
        } catch (e) {
            console.error("Compression failed, using original", e);
            photo = originalPhoto;
        }

        // 0. Get GPS (client-side)
        let gpsString = "";
        try {
            const pos = await new Promise<GeolocationPosition>(
                (resolve, reject) => {
                    navigator.geolocation.getCurrentPosition(resolve, reject, {
                        timeout: 5000,
                    });
                }
            );
            gpsString = `${pos.coords.latitude},${pos.coords.longitude}`;
        } catch (e) {
            console.warn("GPS failed:", e);
        }

        setUploadProgress((prev) => {
            const next = [...prev];
            next[index] = 30;
            return next;
        });

        // 1. Submit via React Router fetcher to the route action
        const formData = new FormData();
        formData.append("photo", photo);
        formData.append("gps", gpsString);
        formData.append("photoIndex", index.toString());

        uploadFetcher.submit(formData, {
            method: "post",
            encType: "multipart/form-data",
        });

        setUploadProgress((prev) => {
            const next = [...prev];
            next[index] = 60;
            return next;
        });
    };

    const handleRetryUpload = (index: number) => {
        handleUploadPhoto(index);
    };

    const badgeTone = (status: string) => {
        switch (status) {
            case "PAID":
                return "success";
            case "PENDING":
                return "warning";
            case "FULFILLED":
                return "success";
            case "UNFULFILLED":
                return "attention";
            default:
                return "info";
        }
    };

    return (
        <Page>
            <BlockStack gap="500">
                {/* Header Section */}
                <Card>
                    <BlockStack gap="200">
                        <InlineStack align="space-between" blockAlign="center">
                            <InlineStack gap="200" blockAlign="center">
                                <Text variant="headingLg" as="h1">
                                    {order.name}
                                </Text>
                                <Badge tone={badgeTone(order.financialStatus)}>
                                    {order.financialStatus}
                                </Badge>
                                <Badge tone={badgeTone(order.fulfillmentStatus)}>
                                    {order.fulfillmentStatus || "UNFULFILLED"}
                                </Badge>
                            </InlineStack>
                            <Button onClick={() => navigate("/app")}>
                                ← Back to Dashboard
                            </Button>
                        </InlineStack>
                        <span suppressHydrationWarning>
                            <Text as="p" tone="subdued">
                                {formatDate(order.createdAt)}
                            </Text>
                        </span>
                    </BlockStack>
                </Card>

                {/* Optional global action banner */}
                {actionData && (
                    <Banner tone={actionData.success ? "success" : "critical"}>
                        {actionData.message}
                    </Banner>
                )}

                {/* Main Content Grid */}
                <Layout>
                    {/* Left Column */}
                    <Layout.Section>
                        <BlockStack gap="500">
                            {/* Products Section */}
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Products
                                    </Text>
                                    <BlockStack gap="300">
                                        {order.products.map((product, index) => (
                                            <InlineStack
                                                key={index}
                                                gap="400"
                                                blockAlign="center"
                                            >
                                                {product.image ? (
                                                    <Thumbnail
                                                        source={product.image}
                                                        alt={product.title}
                                                    />
                                                ) : (
                                                    <div
                                                        style={{
                                                            width: 40,
                                                            height: 40,
                                                            background: "#eee",
                                                            borderRadius: 4,
                                                            display: "flex",
                                                            alignItems: "center",
                                                            justifyContent: "center",
                                                        }}
                                                    >
                                                        📦
                                                    </div>
                                                )}
                                                <BlockStack gap="100">
                                                    <Text
                                                        variant="bodyMd"
                                                        as="span"
                                                        fontWeight="bold"
                                                    >
                                                        {product.title}
                                                    </Text>
                                                    <Text
                                                        variant="bodySm"
                                                        as="span"
                                                        tone="subdued"
                                                    >
                                                        SKU: {product.sku}
                                                    </Text>
                                                    <Text
                                                        variant="bodySm"
                                                        as="span"
                                                        tone="subdued"
                                                    >
                                                        Qty: {product.quantity}
                                                    </Text>
                                                </BlockStack>
                                                <div style={{ marginLeft: "auto" }}>
                                                    <Text
                                                        variant="bodyMd"
                                                        as="span"
                                                        fontWeight="bold"
                                                    >
                                                        {order.currency}{" "}
                                                        {parseFloat(product.price).toFixed(2)}
                                                    </Text>
                                                </div>
                                            </InlineStack>
                                        ))}
                                    </BlockStack>
                                    <Divider />
                                    <InlineStack align="space-between">
                                        <Text variant="headingMd" as="span">
                                            Total
                                        </Text>
                                        <Text variant="headingMd" as="span">
                                            {order.currency}{" "}
                                            {parseFloat(order.totalPrice).toFixed(2)}
                                        </Text>
                                    </InlineStack>
                                </BlockStack>
                            </Card>

                            {/* Verification Details Section - Improved UI */}
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Verification Details
                                    </Text>

                                    {/* Warehouse Section */}
                                    <BlockStack gap="300">
                                        <Text variant="headingSm" as="h3">
                                            📦 Warehouse Enrollment
                                        </Text>
                                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                                            <BlockStack gap="100">
                                                <Text variant="bodySm" as="span" tone="subdued">Enrollment Status</Text>
                                                <div>
                                                    <Badge tone={order.metafields.verification_status === "Enrolled" ? "success" : "info"}>
                                                        {order.metafields.verification_status || "Pending"}
                                                    </Badge>
                                                </div>
                                            </BlockStack>

                                            {order.metafields.nfc_uid && (
                                                <BlockStack gap="100">
                                                    <Text variant="bodySm" as="span" tone="subdued">NFC Tag UID</Text>
                                                    <Text variant="bodyMd" as="span">
                                                        <span style={{ fontFamily: "monospace", background: "#f1f2f3", padding: "2px 4px", borderRadius: "4px" }}>
                                                            🏷️ {order.metafields.nfc_uid}
                                                        </span>
                                                    </Text>
                                                </BlockStack>
                                            )}

                                            {order.metafields.proof_reference && (
                                                <BlockStack gap="100">
                                                    <Text variant="bodySm" as="span" tone="subdued">Proof ID</Text>
                                                    <Text variant="bodyMd" as="span">
                                                        <span style={{ fontFamily: "monospace", background: "#f1f2f3", padding: "2px 4px", borderRadius: "4px" }}>
                                                            🆔 {order.metafields.proof_reference.substring(0, 12)}...
                                                        </span>
                                                    </Text>
                                                </BlockStack>
                                            )}

                                            {order.metafields.delivery_gps && (
                                                <BlockStack gap="100">
                                                    <Text variant="bodySm" as="span" tone="subdued">Warehouse Location</Text>
                                                    {(() => {
                                                        const gps = formatGPS(order.metafields.delivery_gps);
                                                        return gps?.url ? (
                                                            <Button url={gps.url} external size="slim" variant="plain">
                                                                📍 {gps.text}
                                                            </Button>
                                                        ) : (
                                                            <Text variant="bodyMd" as="span">📍 {gps?.text || "N/A"}</Text>
                                                        );
                                                    })()}
                                                </BlockStack>
                                            )}
                                        </div>
                                    </BlockStack>

                                    {/* Customer Section */}
                                    {order.localProof?.verification_status && (
                                        <>
                                            <Divider />
                                            <BlockStack gap="300">
                                                <InlineStack align="space-between">
                                                    <Text variant="headingSm" as="h3">
                                                        👤 Customer Verification
                                                    </Text>
                                                    {order.localProof.verify_url && (
                                                        <Button url={order.localProof.verify_url} external size="slim">
                                                            View on NFS Platform ↗
                                                        </Button>
                                                    )}
                                                </InlineStack>

                                                <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: "16px" }}>
                                                    <BlockStack gap="100">
                                                        <Text variant="bodySm" as="span" tone="subdued">Status</Text>
                                                        <div>
                                                            <Badge
                                                                tone={
                                                                    order.localProof.verification_status === "verified"
                                                                        ? "success"
                                                                        : order.localProof.verification_status === "flagged"
                                                                            ? "critical"
                                                                            : "info"
                                                                }
                                                            >
                                                                {order.localProof.verification_status.toUpperCase()}
                                                            </Badge>
                                                        </div>
                                                    </BlockStack>

                                                    {order.localProof.verification_updated_at && (
                                                        <BlockStack gap="100">
                                                            <Text variant="bodySm" as="span" tone="subdued">Last Verified</Text>
                                                            <Text variant="bodyMd" as="span">
                                                                🕐 {formatDate(order.localProof.verification_updated_at)}
                                                            </Text>
                                                        </BlockStack>
                                                    )}

                                                    {order.localProof.distance_meters != null && (
                                                        <BlockStack gap="100">
                                                            <Text variant="bodySm" as="span" tone="subdued">Distance from Warehouse</Text>
                                                            <Text variant="bodyMd" as="span">
                                                                📏 {Math.round(order.localProof.distance_meters)} meters
                                                            </Text>
                                                        </BlockStack>
                                                    )}
                                                </div>
                                            </BlockStack>
                                        </>
                                    )}

                                    {!order.metafields.verification_status && !order.localProof?.verification_status && (
                                        <Banner tone="warning">
                                            No verification data available yet. Package needs to be enrolled at warehouse.
                                        </Banner>
                                    )}
                                </BlockStack>
                            </Card>

                            {/* Photo Upload Section */}
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Delivery Proof Photos
                                    </Text>
                                    <Text as="p" tone="subdued">
                                        Upload 4 photos as proof of delivery. Accepted formats:
                                        JPG, PNG (Max 5MB each)
                                    </Text>

                                    <div
                                        style={{
                                            display: "grid",
                                            gridTemplateColumns: "repeat(2, 1fr)",
                                            gap: "16px",
                                        }}
                                    >
                                        {[0, 1, 2, 3].map((index) => (
                                            <div
                                                key={index}
                                                style={{
                                                    border:
                                                        uploadStatus[index] === "error"
                                                            ? "2px dashed #d72c0d"
                                                            : uploadStatus[index] === "success"
                                                                ? "2px dashed #008060"
                                                                : "2px dashed #c9cccf",
                                                    borderRadius: "8px",
                                                    padding: "16px",
                                                    textAlign: "center",
                                                    background: photoPreviews[index] ? "#fff" : "#f6f6f7",
                                                    position: "relative",
                                                    overflow: "hidden",
                                                    minHeight: "150px",
                                                    display: "flex",
                                                    flexDirection: "column",
                                                    justifyContent: "center",
                                                    alignItems: "center",
                                                }}

                                            >
                                                {uploadStatus[index] === "uploading" && (
                                                    <div
                                                        style={{
                                                            position: "absolute",
                                                            inset: 0,
                                                            background: "rgba(255,255,255,0.9)",
                                                            zIndex: 10,
                                                            display: "flex",
                                                            flexDirection: "column",
                                                            alignItems: "center",
                                                            justifyContent: "center",
                                                        }}
                                                    >
                                                        <Spinner size="large" />
                                                        <Text as="span" fontWeight="bold">
                                                            Uploading...
                                                        </Text>
                                                        <div
                                                            style={{
                                                                width: "80%",
                                                                height: 4,
                                                                background: "#eee",
                                                                marginTop: 8,
                                                            }}
                                                        >
                                                            <div
                                                                style={{
                                                                    width: `${uploadProgress[index]}%`,
                                                                    height: "100%",
                                                                    background: "green",
                                                                }}
                                                            />
                                                        </div>
                                                    </div>
                                                )}

                                                {uploadStatus[index] === "success" && (
                                                    <div
                                                        style={{
                                                            position: "absolute",
                                                            top: 8,
                                                            right: 8,
                                                            zIndex: 5,
                                                        }}
                                                    >
                                                        <Badge tone="success">VERIFIED</Badge>
                                                    </div>
                                                )}

                                                {photoPreviews[index] ? (
                                                    <>
                                                        <img
                                                            src={photoPreviews[index]!}
                                                            alt="Preview"
                                                            style={{
                                                                width: "100%",
                                                                maxHeight: "120px",
                                                                objectFit: "cover",
                                                                marginBottom: 8,
                                                            }}
                                                        />
                                                        <InlineStack gap="200">
                                                            <Button
                                                                tone="critical"
                                                                onClick={() =>
                                                                    handleRemovePhoto(index)
                                                                }
                                                                disabled={
                                                                    uploadStatus[index] === "uploading"
                                                                }
                                                            >
                                                                Remove
                                                            </Button>
                                                            {uploadStatus[index] !== "success" && (
                                                                <Button
                                                                    variant="primary"
                                                                    onClick={() =>
                                                                        handleUploadPhoto(index)
                                                                    }
                                                                    disabled={
                                                                        uploadStatus[index] === "uploading"
                                                                    }
                                                                >
                                                                    Upload
                                                                </Button>
                                                            )}
                                                            {uploadStatus[index] === "error" && (
                                                                <Button
                                                                    onClick={() =>
                                                                        handleRetryUpload(index)
                                                                    }
                                                                >
                                                                    Retry
                                                                </Button>
                                                            )}
                                                        </InlineStack>
                                                    </>
                                                ) : (
                                                    <>
                                                        <div
                                                            style={{
                                                                fontSize: "32px",
                                                                marginBottom: 8,
                                                            }}
                                                        >
                                                            📷
                                                        </div>
                                                        <input
                                                            type="file"
                                                            accept="image/*"
                                                            id={`photo-input-${index}`}
                                                            style={{ display: "none" }}
                                                            onChange={(e) =>
                                                                handleFileSelect(
                                                                    index,
                                                                    e.target.files?.[0] || null
                                                                )
                                                            }
                                                        />
                                                        <label htmlFor={`photo-input-${index}`}>
                                                            <Button
                                                                onClick={() =>
                                                                    document
                                                                        .getElementById(
                                                                            `photo-input-${index}`
                                                                        )
                                                                        ?.click()
                                                                }
                                                            >
                                                                Choose File
                                                            </Button>
                                                        </label>
                                                    </>
                                                )}
                                            </div>
                                        ))}
                                    </div>

                                    <div
                                        style={{
                                            background: "#f6f6f7",
                                            padding: 12,
                                            borderRadius: 8,
                                        }}
                                    >
                                        <InlineStack align="space-between">
                                            <Text as="span" fontWeight="bold">
                                                Upload Status:
                                            </Text>
                                            <Text as="span">
                                                {
                                                    uploadStatus.filter((s) => s === "success")
                                                        .length
                                                }
                                                /4 photos verified
                                            </Text>
                                        </InlineStack>
                                    </div>
                                </BlockStack>
                            </Card>
                        </BlockStack>
                    </Layout.Section>

                    {/* Right Column */}
                    <Layout.Section variant="oneThird">
                        <BlockStack gap="500">
                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Customer
                                    </Text>
                                    <BlockStack gap="200">
                                        <Text variant="bodyMd" as="p" fontWeight="bold">
                                            {order.customerName}
                                        </Text>
                                        <Text variant="bodyMd" as="p" tone="subdued">
                                            {order.customerEmail}
                                        </Text>
                                        <Text variant="bodyMd" as="p" tone="subdued">
                                            {order.customerPhone}
                                        </Text>
                                    </BlockStack>
                                </BlockStack>
                            </Card>

                            <Card>
                                <BlockStack gap="400">
                                    <Text variant="headingMd" as="h2">
                                        Shipping Address
                                    </Text>
                                    {order.shippingAddress ? (
                                        <BlockStack gap="100">
                                            <Text as="p">
                                                {order.shippingAddress.address1}
                                            </Text>
                                            {order.shippingAddress.address2 && (
                                                <Text as="p">
                                                    {order.shippingAddress.address2}
                                                </Text>
                                            )}
                                            <Text as="p">
                                                {order.shippingAddress.city},{" "}
                                                {order.shippingAddress.province}{" "}
                                                {order.shippingAddress.zip}
                                            </Text>
                                            <Text as="p">
                                                {order.shippingAddress.country}
                                            </Text>
                                        </BlockStack>
                                    ) : (
                                        <Text as="p" tone="subdued">
                                            No shipping address available
                                        </Text>
                                    )}
                                </BlockStack>
                            </Card>
                        </BlockStack>
                    </Layout.Section>
                </Layout>
            </BlockStack>
        </Page>
    );
}

export function ErrorBoundary() {
    return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (args) => boundary.headers(args);