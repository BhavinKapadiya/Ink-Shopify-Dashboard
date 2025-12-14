// ============================================================
// DEPRECATED: check-proofs.ts
// ============================================================
// This utility was used to check local Proof records in the database.
// Since we've removed the local Proof table and now use Alan's NFS API
// as the single source of truth, this script is no longer needed.
//
// To check proof data, use Alan's API directly:
//   GET http://193.57.137.90/retrieve/{proof_id}
//
// Or check Shopify Order metafields for proof_reference
// ============================================================

console.log("⚠️ This utility has been deprecated.");
console.log("📌 Proof data is now stored in Alan's NFS API (single source of truth).");
console.log("📌 To retrieve proof data, use: GET http://193.57.137.90/retrieve/{proof_id}");
console.log("📌 The proof_id is stored in Shopify Order metafields (key: 'proof_reference').");
