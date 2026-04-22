// Let's check exactly what is in Firestore for merchants
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

const projectId = process.env.FIREBASE_PROJECT_ID;
const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
const privateKey = process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, '\n');

if (!projectId || !clientEmail || !privateKey) {
  console.error('❌ Missing Firebase env vars');
  process.exit(1);
}

const { initializeApp, cert, getApps } = await import('firebase-admin/app');
const { getFirestore } = await import('firebase-admin/firestore');

const app = getApps().length === 0
  ? initializeApp({ credential: cert({ projectId, clientEmail, privateKey }) })
  : getApps()[0];

const db = getFirestore(app);

const shop = 'taimoor1-2.myshopify.com';

const snap = await db.collection('merchants').where('shopDomain', '==', shop).limit(1).get();

if (snap.empty) {
  console.error(`❌ No Firestore merchant found for shopDomain: ${shop}`);
  process.exit(1);
}

const doc = snap.docs[0];
console.log(`Document ID: ${doc.id}`);
const data = doc.data();
console.log('merchant_media:', JSON.stringify(data.merchant_media, null, 2));

