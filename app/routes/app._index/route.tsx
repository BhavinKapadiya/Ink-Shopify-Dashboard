import { useState } from "react";
import { useLoaderData, Link } from "react-router";
import type { LoaderFunctionArgs } from "react-router";
import { authenticate } from "../../shopify.server";

// Local interface for Proof since Prisma export is failing
interface Proof {
    order_id: string;
    enrollment_status: string | null;
    nfc_uid: string | null;
    nfs_proof_id: string | null;
}

// Define types for our data
interface Order {
    id: string;
    name: string;
    createdAt: string;
    financialStatus: string;
    fulfillmentStatus: string;
    totalPrice: string;
    currency: string;
    customerName: string;
    customerEmail: string;
    verificationStatus: string;
    nfcUid: string;
    hasProof: boolean;
    nfsProofId: string;
}

interface LoaderData {
    orders: Order[];
}

interface StatusBadge {
    tone: "success" | "attention" | "critical" | "info";
    icon: string;
    text: string;
}

// Loader: Fetch orders and local proofs
export const loader = async ({ request }: LoaderFunctionArgs) => {
    const { admin } = await authenticate.admin(request);
    const { PrismaClient } = await import("@prisma/client");
    const prisma = new PrismaClient();

    // 1. Fetch local proofs
    console.log("🔍 Dashboard Loader: Fetching proofs...");
    const proofs = await prisma.proof.findMany() as Proof[];
    console.log(`✅ Dashboard Loader: Found ${proofs.length} proofs.`);
    if (proofs.length > 0) {
        console.log("🔍 Sample Proof IDs:", proofs.slice(0, 3).map(p => p.order_id).join(", "));
    }
    const proofMap = new Map(proofs.map(p => [p.order_id, p]));

    // 2. GraphQL query to fetch orders
    const query = `
    query GetOrders {
      orders(first: 50, reverse: true) {
        edges {
          node {
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
            }
          }
        }
      }
    }
  `;

    try {
        const response = await admin.graphql(query);
        const data = await response.json();

        // 3. Merge Shopify data with Local Proof data
        const orders: Order[] = data.data?.orders?.edges?.map((edge: any) => {
            const order = edge.node;
            const numericId = order.id.replace("gid://shopify/Order/", "");

            // Proofs are stored by Order Number (e.g. "1003"), not Shopify ID
            // order.name is usually "#1003", so we strip the "#"
            const orderNumber = order.name.replace("#", "");

            // Try matching by order number first (most likely), then by numeric ID (fallback)
            const proof = proofMap.get(orderNumber) || proofMap.get(numericId);

            return {
                id: numericId,
                name: order.name,
                createdAt: order.createdAt,
                financialStatus: order.displayFinancialStatus,
                fulfillmentStatus: order.displayFulfillmentStatus,
                totalPrice: order.totalPriceSet.shopMoney.amount,
                currency: order.totalPriceSet.shopMoney.currencyCode,
                customerName: order.customer
                    ? `${order.customer.firstName} ${order.customer.lastName}`
                    : "Guest",
                customerEmail: order.customer?.email || "",
                // Prioritize local DB status, fallback to "Pending"
                verificationStatus: proof?.enrollment_status || (proof ? "Enrolled (Local)" : "Pending"),
                nfcUid: proof?.nfc_uid || "",
                hasProof: !!proof,
                nfsProofId: proof?.nfs_proof_id || "",
            };
        }) || [];

        await prisma.$disconnect();
        return { orders };
    } catch (error) {
        console.error("Error fetching orders:", error);
        await prisma.$disconnect();
        return { orders: [] };
    }
};

// Helper function to get badge tone based on status
function getStatusBadge(status: string): StatusBadge {
    const statusLower = status ? status.toLowerCase() : "pending";

    if (statusLower === "verified") {
        return { tone: "success", icon: "✅", text: "Enrolled" };
    }

    // Everything else (Pending, Enrolled (Local), etc) shows as Pending
    return { tone: "attention", icon: "⏳", text: "Pending" };
}

// Helper function to format date
function formatDate(isoDate: string): string {
    const date = new Date(isoDate);
    return date.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
    });
}

export default function DashboardHome() {
    const { orders } = useLoaderData<LoaderData>();
    const [searchTerm, setSearchTerm] = useState("");

    // Filter orders based on search
    const filteredOrders = orders.filter((order: Order) =>
        order.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        order.customerName.toLowerCase().includes(searchTerm.toLowerCase())
    );

    return (
        <s-page>
            <s-section heading="Delivery Verification Dashboard">
                {/* Summary Cards */}
                <div style={{
                    display: "grid",
                    gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
                    gap: "16px",
                    marginBottom: "24px"
                }}>
                    <div style={{
                        padding: "16px",
                        background: "#f6f6f7",
                        borderRadius: "8px",
                        border: "1px solid #e1e3e5"
                    }}>
                        <div style={{ fontSize: "24px", fontWeight: "bold" }}>{orders.length}</div>
                        <div style={{ color: "#6d7175", fontSize: "14px" }}>Total Orders</div>
                    </div>

                    <div style={{
                        padding: "16px",
                        background: "#f6f6f7",
                        borderRadius: "8px",
                        border: "1px solid #e1e3e5"
                    }}>
                        <div style={{ fontSize: "24px", fontWeight: "bold", color: "#008060" }}>
                            {orders.filter((o: Order) => o.verificationStatus.toLowerCase() === "verified").length}
                        </div>
                        <div style={{ color: "#6d7175", fontSize: "14px" }}>Enrolled</div>
                    </div>

                    <div style={{
                        padding: "16px",
                        background: "#f6f6f7",
                        borderRadius: "8px",
                        border: "1px solid #e1e3e5"
                    }}>
                        <div style={{ fontSize: "24px", fontWeight: "bold", color: "#ffa500" }}>
                            {orders.filter((o: Order) => o.verificationStatus.toLowerCase() !== "verified").length}
                        </div>
                        <div style={{ color: "#6d7175", fontSize: "14px" }}>Pending</div>
                    </div>
                </div>

                {/* Search Bar */}
                <div style={{ marginBottom: "16px" }}>
                    <s-text-field
                        label="Search Orders"
                        placeholder="Search by order number or customer name..."
                        value={searchTerm}
                        // @ts-ignore
                        onChange={(e) => setSearchTerm(e.currentTarget.value)}
                    />
                </div>

                {/* Orders Table */}
                {filteredOrders.length === 0 ? (
                    <div style={{
                        padding: "48px",
                        textAlign: "center",
                        background: "#f6f6f7",
                        borderRadius: "8px"
                    }}>
                        <p style={{ fontSize: "16px", color: "#6d7175" }}>
                            {searchTerm ? "No orders found matching your search" : "No orders yet"}
                        </p>
                    </div>
                ) : (
                    <div style={{
                        border: "1px solid #e1e3e5",
                        borderRadius: "8px",
                        overflow: "hidden"
                    }}>
                        <table style={{ width: "100%", borderCollapse: "collapse" }}>
                            <thead style={{ background: "#f6f6f7" }}>
                                <tr>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Order
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Customer
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Date
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Total
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Status
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "left", borderBottom: "1px solid #e1e3e5" }}>
                                        Verification
                                    </th>
                                    <th style={{ padding: "12px", textAlign: "center", borderBottom: "1px solid #e1e3e5" }}>
                                        Action
                                    </th>
                                </tr>
                            </thead>
                            <tbody>
                                {filteredOrders.map((order: Order) => {
                                    const badge = getStatusBadge(order.verificationStatus);
                                    return (
                                        <tr key={order.id} style={{ borderBottom: "1px solid #e1e3e5" }}>
                                            <td style={{ padding: "12px" }}>
                                                <strong>{order.name}</strong>
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                <div>{order.customerName}</div>
                                                <div style={{ fontSize: "12px", color: "#6d7175" }}>
                                                    {order.customerEmail}
                                                </div>
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                {formatDate(order.createdAt)}
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                <strong>
                                                    {order.currency} {parseFloat(order.totalPrice).toFixed(2)}
                                                </strong>
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                <div style={{ fontSize: "12px" }}>
                                                    <div>{order.fulfillmentStatus || "Unfulfilled"}</div>
                                                    <div style={{ color: "#6d7175" }}>{order.financialStatus}</div>
                                                </div>
                                            </td>
                                            <td style={{ padding: "12px" }}>
                                                <s-badge
                                                    // @ts-ignore
                                                    tone={badge.tone}
                                                >
                                                    {badge.icon} {badge.text}
                                                </s-badge>
                                                {order.hasProof && (
                                                    <div style={{ fontSize: "11px", color: "#008060", marginTop: "4px" }}>
                                                        📷 Photos uploaded
                                                    </div>
                                                )}
                                                {order.nfcUid && (
                                                    <div style={{ fontSize: "11px", color: "#0066cc", marginTop: "2px" }}>
                                                        🏷️ UID: {order.nfcUid}
                                                    </div>
                                                )}
                                                {order.nfsProofId && (
                                                    <div style={{ fontSize: "10px", color: "#666", marginTop: "2px" }}>
                                                        🆔 NFS: {order.nfsProofId.slice(0, 10)}...
                                                    </div>
                                                )}
                                            </td>
                                            <td style={{ padding: "12px", textAlign: "center" }}>
                                                <Link
                                                    to={`/app/orders/${order.id}`}
                                                    style={{
                                                        padding: "6px 12px",
                                                        background: "#008060",
                                                        color: "white",
                                                        textDecoration: "none",
                                                        borderRadius: "4px",
                                                        fontSize: "14px",
                                                        display: "inline-block"
                                                    }}
                                                >
                                                    View Details
                                                </Link>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </s-section>
        </s-page>
    );
}