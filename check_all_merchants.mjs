import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

const app = getApps().length === 0
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApps()[0];

const db = getFirestore(app);

const snap = await db.collection('merchants').get();
console.log(`Found ${snap.docs.length} merchants.`);
snap.docs.forEach((doc, idx) => {
    console.log(`[${idx}] ID: ${doc.id}, domain: ${doc.data().shopDomain}, key: ${doc.data().ink_api_key?.substring(0,8)}... media: ${(doc.data().merchant_media||[]).length}`);
});
