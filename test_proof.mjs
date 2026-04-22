import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

async function checkProof() {
  const serial = 'proof_165b327f492ac895f82187dc';
  const INK_API_BASE = "https://us-central1-inink-c76d3.cloudfunctions.net/api";
  const apiKey = "sk_f9b0aa37e8c3b7b2ce8f731c34a2cdfb22e86bc06a3233802be55da54fe8e29a"; // Wait, I don't know the API key. Let me get it from DB.
  
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');
  const { initializeApp, cert, getApps } = await import('firebase-admin/app');
  const { getFirestore } = await import('firebase-admin/firestore');

  let app;
  if (!getApps().length) {
    app = initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) });
  } else {
    app = getApps()[0];
  }
  const db = getFirestore(app);
  
  const doc = await db.collection("merchants").doc("taimoor1-2.myshopify.com").get();
  const dbKey = doc.data().ink_api_key;

  const proofUrl = `${INK_API_BASE}/proofs/${serial}`;
  console.log('Querying: ' + proofUrl);
  const resp = await fetch(proofUrl, { headers: { "Authorization": `Bearer ${dbKey}` } });
  
  const text = await resp.text();
  console.log('Response ' + resp.status);
  console.log(text);
}

checkProof();
