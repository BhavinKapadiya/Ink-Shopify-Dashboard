import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const dotenv = require('dotenv');
dotenv.config();

async function checkAlan() {
  const alanId = 'shop_a66c803d28e0f57f';
  // Strip nothing, just use the direct URL that verify.tsx uses:
  const animsUrl = `https://us-central1-inink-c76d3.cloudfunctions.net/api/admin/merchant-animations/${alanId}`;
  
  const INK_ADMIN_SECRET = process.env.INK_ADMIN_SECRET || "ink_admin_aeb5c9d6e822a4e57d95a6a2224aada64230e48d89acad5782057fcb865548a2";
  
  console.log('Querying: ' + animsUrl);
  const animResp = await fetch(animsUrl, {
      headers: { "Authorization": `Bearer ${INK_ADMIN_SECRET}` }
  });
  
  const text = await animResp.text();
  console.log('Response ' + animResp.status);
  console.log(text);
}

checkAlan();
