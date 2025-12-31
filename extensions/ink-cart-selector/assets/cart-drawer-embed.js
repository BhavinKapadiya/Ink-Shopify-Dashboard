(function () {
  'use strict';
  if (document.body.dataset.inkLoaded === '1') return;
  document.body.dataset.inkLoaded = '1';

  const CSS = `.ink-ship{margin:16px;padding:16px;background:#f9fafb;border-radius:10px;font-family:system-ui,sans-serif}.ink-ship h4{margin:0 0 12px;font-size:14px;font-weight:600}.ink-ship .opts{display:flex;flex-direction:column;gap:8px}.ink-ship .opt{display:flex;padding:12px;border:2px solid #e5e7eb;border-radius:8px;background:#fff;cursor:pointer}.ink-ship .opt:hover{border-color:#9ca3af}.ink-ship .opt.sel{border-color:#000}.ink-ship .opt.prem.sel{background:#fffbeb}.ink-ship .rd{margin:2px 10px 0 0;width:16px;height:16px}.ink-ship .cnt{flex:1}.ink-ship .hdr{display:flex;justify-content:space-between;margin-bottom:4px}.ink-ship .ttl{font-size:13px;font-weight:600}.ink-ship .bdg{background:#000;color:#fff;padding:2px 6px;border-radius:3px;font-size:9px;margin-top:4px;display:inline-block}.ink-ship .prc{font-weight:600;font-size:13px}.ink-ship .dtl{margin:0;font-size:12px;color:#6b7280}.ink-ship .ft{margin:2px 0 0;font-size:11px;color:#374151}.ink-ship.busy{opacity:.5;pointer-events:none}`;

  if (!document.getElementById('ink-css')) { const s = document.createElement('style'); s.id = 'ink-css'; s.textContent = CSS; document.head.appendChild(s) }

  const cfg = (() => {
    const el = document.getElementById('ink-drawer-settings');
    return {
      h: el?.dataset?.heading || 'Shipping Method',
      st: el?.dataset?.standardTitle || 'Standard Shipping',
      sp: (el?.dataset?.standardPrice || 'Free').replace(/^free$/i, 'Free'),
      sd: el?.dataset?.standardDetail || '5-7 business days',
      pt: el?.dataset?.premiumTitle || 'ink. Premium Shipping',
      pp: (el?.dataset?.premiumPrice || 'Free').replace(/^free$/i, 'Free'),
      pd: el?.dataset?.premiumDetail || '2-day delivery with verification',
      f1: el?.dataset?.premiumFeature1 || 'Priority handling',
      f2: el?.dataset?.premiumFeature2 || 'Delivery confirmation',
      f3: el?.dataset?.premiumFeature3 || 'Easy returns',
      vid: el?.dataset?.premiumVariantId || ''
    };
  })();

  async function getCart() { try { return await (await fetch('/cart.js')).json() } catch { return null } }

  function findPrem(cart) {
    for (const i of cart?.items || []) {
      const t = (i.product_title || '').toLowerCase();
      if ((t.includes('ink') && (t.includes('protected') || t.includes('premium') || t.includes('delivery'))) || (i.properties?._ink_premium_fee === 'true')) return i;
    }
    return null;
  }

  async function getVid() {
    let v = cfg.vid;
    if (v?.includes('/')) v = v.match(/variants\/(\d+)/)?.[1] || v;
    if (v && !/^\d+$/.test(v)) v = v.match(/(\d{10,})/)?.[1] || '';
    if (v && /^\d+$/.test(v)) return v;
    for (const h of ['ink-protected-delivery', 'premium-shipping']) {
      try { const r = await fetch('/products/' + h + '.js'); if (r.ok) { const p = await r.json(); if (p.available) return String(p.variants[0].id) } } catch { }
    }
    return null;
  }

  async function addPrem(w) {
    w.classList.add('busy');
    const v = await getVid();
    if (!v) { alert('Configure Premium Variant ID in Theme > App embeds'); w.classList.remove('busy'); return 0 }
    try {
      const r = await fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: +v, quantity: 1, properties: { _ink_premium_fee: 'true' } }] }) });
      if (!r.ok) { const e = await r.json(); alert(e.description || 'Error'); w.classList.remove('busy'); return 0 }
    } catch { w.classList.remove('busy'); return 0 }
    w.classList.remove('busy'); return 1;
  }

  async function remPrem(w, key) {
    w.classList.add('busy');
    try { await fetch('/cart/change.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: key, quantity: 0 }) }) } catch { }
    w.classList.remove('busy');
  }

  function build(prem) {
    const d = document.createElement('div'); d.className = 'ink-ship'; d.id = 'ink-ship';
    d.innerHTML = `<h4>${cfg.h}</h4><div class="opts"><label class="opt std ${prem ? '' : 'sel'}"><input type="radio" name="ink_s" value="s" ${prem ? '' : 'checked'} class="rd"><div class="cnt"><div class="hdr"><span class="ttl">${cfg.st}</span><span class="prc">${cfg.sp}</span></div><p class="dtl">${cfg.sd}</p></div></label><label class="opt prem ${prem ? 'sel' : ''}"><input type="radio" name="ink_s" value="p" ${prem ? 'checked' : ''} class="rd"><div class="cnt"><div class="hdr"><span class="ttl">${cfg.pt}</span><span class="prc">${cfg.pp}</span></div><div class="bdg">⭐ RECOMMENDED</div><p class="dtl">${cfg.pd}</p><p class="ft">${cfg.f1}</p><p class="ft">${cfg.f2}</p><p class="ft">${cfg.f3}</p></div></label></div>`;
    return d;
  }

  function refreshCart() {
    // Try to refresh cart section via Shopify's section rendering
    const drawer = document.querySelector('cart-drawer,[data-cart-drawer]');
    if (drawer && drawer.tagName === 'CART-DRAWER') {
      // Dawn theme - use section rendering
      fetch('/?section_id=cart-drawer').then(r => r.text()).then(html => {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        const newContent = doc.querySelector('cart-drawer');
        if (newContent && drawer.parentElement) {
          drawer.innerHTML = newContent.innerHTML;
          setTimeout(inject, 100);
        }
      }).catch(() => { });
    } else {
      // Fallback: dispatch events and let theme handle
      document.dispatchEvent(new CustomEvent('cart:refresh'));
      document.dispatchEvent(new CustomEvent('cart:updated'));
    }
  }

  let pItem = null, timer = null;

  async function inject() {
    // Skip if widget exists
    if (document.getElementById('ink-ship')) return;

    const cart = await getCart();
    if (!cart || cart.item_count === 0) return;

    const btn = document.querySelector('button[name="checkout"],a[href*="/checkout"],.cart__checkout-button');
    if (!btn?.parentElement) return;

    pItem = findPrem(cart);
    const w = build(!!pItem);
    btn.parentElement.insertBefore(w, btn);

    w.querySelectorAll('input').forEach(r => r.addEventListener('change', async function () {
      w.querySelectorAll('.opt').forEach(o => o.classList.remove('sel'));
      this.closest('.opt').classList.add('sel');
      if (this.value === 'p' && !pItem) {
        if (await addPrem(w)) {
          pItem = { key: 'temp' };// Mark as having premium
          refreshCart();
        }
      } else if (this.value === 's' && pItem) {
        await remPrem(w, pItem.key);
        pItem = null;
        refreshCart();
      }
    }));
  }

  function tryInject() {
    clearTimeout(timer);
    timer = setTimeout(inject, 100);
  }

  // Observer for cart drawer
  new MutationObserver(m => {
    for (const x of m) {
      if (x.addedNodes.length) for (const n of x.addedNodes) if (n.nodeType === 1 && (n.tagName === 'CART-DRAWER' || n.className?.includes?.('cart'))) tryInject();
      if (x.type === 'attributes' && x.target.tagName === 'CART-DRAWER') tryInject();
    }
  }).observe(document.body, { childList: 1, subtree: 1, attributes: 1, attributeFilter: ['open'] });

  document.addEventListener('click', e => { if (e.target.closest('[href*="cart"],[class*="cart"]')) tryInject() }, 1);
  setTimeout(tryInject, 200);
})();
