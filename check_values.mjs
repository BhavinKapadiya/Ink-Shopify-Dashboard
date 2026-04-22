import admin from "firebase-admin";

const serviceAccount = {
  // Service account info would be here, but we can just use the standard initialization
};

if (!admin.apps.length) {
  // Use application default credentials since we are running on GCP or have GOOGLE_APPLICATION_CREDENTIALS
  admin.initializeApp({
      projectId: 'inink-c76d3'
  });
}

const firestore = admin.firestore();

async function checkValues() {
  const doc = await firestore.collection("merchants").doc("taimoor1-2.myshopify.com").get();
  const data = doc.data() || {};
  console.log("Current values in Firestore for taimoor1-2.myshopify.com:");
  console.log("low_inventory_threshold:", data.low_inventory_threshold);
  console.log("min_enrollment_value:", data.min_enrollment_value);
}

checkValues().catch(console.error);
