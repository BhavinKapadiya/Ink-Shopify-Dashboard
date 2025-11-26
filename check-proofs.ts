import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  const dbUrl = process.env.DATABASE_URL || "";
  const maskedUrl = dbUrl.replace(/:[^:@]+@/, ":****@");
  console.log(`🔍 Checking Proof records in database...`);
  console.log(`🔌 Connecting to: ${maskedUrl}`);
  
  try {
    const proofs = await prisma.proof.findMany({
      orderBy: { enrollment_timestamp: 'desc' },
      take: 5
    });

    if (proofs.length === 0) {
      console.log("⚠️ No proofs found in the database.");
    } else {
      console.log(`✅ Found ${proofs.length} recent proofs:`);
      proofs.forEach((p) => {
        console.log("------------------------------------------------");
        console.log(`🆔 Proof ID: ${p.proof_id}`);
        console.log(`📦 Order ID: ${p.order_id}`);
        console.log(`🏷️ NFC UID: ${p.nfc_uid}`);
        console.log(`☁️ NFS Proof ID: ${p.nfs_proof_id || "N/A"}`);
        console.log(`📊 Status: ${p.enrollment_status || "N/A"}`);
        console.log(`🔑 Key ID: ${p.key_id || "N/A"}`);
        console.log(`📅 Time: ${p.enrollment_timestamp.toLocaleString()}`);
        console.log("RAW JSON:", JSON.stringify(p, null, 2));
      });
      console.log("------------------------------------------------");
    }
  } catch (error) {
    console.error("❌ Error querying database:", error);
  } finally {
    await prisma.$disconnect();
  }
}

main();
