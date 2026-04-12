/**
 * LowInventoryAlert — sticker reorder prompt for the Shopify embedded app.
 *
 * Thresholds:
 *   critical : remaining ≤ 0   → full-screen modal
 *   low      : remaining < 20  → dismissible yellow banner
 *   ok       : remaining ≥ 20  → renders nothing
 */

import { useState } from "react";

const REORDER_URL = "https://shop.in.ink";
const LOW_THRESHOLD = 20;
const CRITICAL_THRESHOLD = 0;

interface LowInventoryAlertProps {
  remaining: number;
  total: number;
  isLoading?: boolean;
}

export function LowInventoryAlert({ remaining, total, isLoading = false }: LowInventoryAlertProps) {
  const [bannerDismissed, setBannerDismissed] = useState(false);
  const [modalDismissed, setModalDismissed] = useState(false);

  const isCritical = remaining <= CRITICAL_THRESHOLD;

  if (isLoading) return null;
  if (remaining >= LOW_THRESHOLD) return null;
  if (isCritical && modalDismissed) return null;

  const handleReorder = () => window.open(REORDER_URL, "_blank", "noopener");

  if (isCritical) {
    return (
      <div role="dialog" aria-modal="true" aria-labelledby="inv-critical-title" style={{ position:"fixed", inset:0, zIndex:9999, display:"flex", alignItems:"center", justifyContent:"center", background:"rgba(0,0,0,0.55)", padding:"16px" }}>
        <div style={{ background:"#fff", borderRadius:"16px", maxWidth:"420px", width:"100%", padding:"32px 28px", position:"relative", textAlign:"center", boxShadow:"0 20px 60px rgba(0,0,0,0.25)" }}>
        {/* Close button */}
        <button onClick={() => setModalDismissed(true)} aria-label="Close alert" style={{ position:"absolute", top:"14px", right:"14px", background:"none", border:"none", cursor:"pointer", color:"#999", fontSize:"20px", lineHeight:1, padding:"4px 6px" }}>✕</button>
          <div style={{ width:"64px", height:"64px", borderRadius:"50%", background:"#FEF2F2", display:"flex", alignItems:"center", justifyContent:"center", margin:"0 auto 20px" }}>
            <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="#EF4444" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/>
            </svg>
          </div>
          <h2 id="inv-critical-title" style={{ fontSize:"20px", fontWeight:700, color:"#111", marginBottom:"10px" }}>Out of NFC Stickers</h2>
          <p style={{ fontSize:"14px", color:"#666", marginBottom:"6px" }}>
            Your inventory has reached <strong style={{ color:"#EF4444" }}>{remaining} / {total}</strong>.
          </p>
          <p style={{ fontSize:"14px", color:"#666", marginBottom:"28px" }}>
            Enrolling new shipments is blocked until you reorder. Place an order now to keep your warehouse running.
          </p>
          <button onClick={handleReorder} style={{ width:"100%", padding:"14px", background:"#111", color:"#fff", border:"none", borderRadius:"10px", fontSize:"15px", fontWeight:600, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", gap:"8px", marginBottom:"12px" }}>
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/>
              <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6"/>
            </svg>
            Reorder Stickers at shop.in.ink
          </button>
          <p style={{ fontSize:"12px", color:"#999" }}>Opens <strong>shop.in.ink</strong> in a new tab</p>
        </div>
      </div>
    );
  }

  if (bannerDismissed) return null;

  return (
    <div role="alert" style={{ display:"flex", alignItems:"center", gap:"12px", padding:"12px 16px", background:"#FFFBEB", border:"1px solid #FCD34D", borderRadius:"10px", marginBottom:"16px" }}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#D97706" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink:0 }}>
        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/>
        <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
      </svg>
      <div style={{ flex:1 }}>
        <p style={{ fontSize:"13px", fontWeight:600, color:"#92400E", margin:0 }}>
          Low sticker inventory — {remaining} / {total} remaining
        </p>
        <p style={{ fontSize:"12px", color:"#B45309", margin:"2px 0 0" }}>
          Reorder soon to avoid delays.{" "}
          <button onClick={handleReorder} style={{ background:"none", border:"none", color:"#B45309", fontWeight:700, cursor:"pointer", textDecoration:"underline", padding:0, fontSize:"12px" }}>
            Order at shop.in.ink →
          </button>
        </p>
      </div>
      <button onClick={() => setBannerDismissed(true)} aria-label="Dismiss" style={{ background:"none", border:"none", cursor:"pointer", padding:"2px", color:"#B45309", fontSize:"18px" }}>✕</button>
    </div>
  );
}
