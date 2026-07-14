if (typeof importScripts !== 'undefined') {
  importScripts("highs.js");
}

chrome.runtime.onInstalled.addListener(() => {
  console.log("ACO - Cart Optimizer extension installed successfully.");
  chrome.storage.local.get(["aco_stats"], (result) => {
    if (!result.aco_stats) {
      chrome.storage.local.set({
        aco_stats: {
          total_optimizations: 0,
          total_saved: 0.0,
          average_saved: 0.0,
          max_single_saved: 0.0
        }
      });
    }
  });
});

let highsInstance = null;

async function getHighs() {
  if (!highsInstance) {
    console.log("[Background] Inicjalizacja HiGHS WASM...");
    // The highs library exposes a global function `Module` when loaded via importScripts
    highsInstance = await self.Module({
      locateFile: (file) => chrome.runtime.getURL(file)
    });
    console.log("[Background] HiGHS gotowy.");
  }
  return highsInstance;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.action === "getTabUrl") {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      sendResponse({ url: tabs && tabs[0] ? tabs[0].url : "" });
    });
    return true;
  }

  if (message.action === "optimizeCart") {
    console.log("[Background] Otrzymano zlecenie optymalizacji", message.offers.length, "ofert.");

    // Firefox MV3 (background scripts) supports returning a Promise from
    // onMessage to keep the channel open – this is more reliable than
    // returning `true` + calling sendResponse asynchronously, which can
    // silently fail in Firefox.
    // Chrome (service worker) also handles a returned Promise correctly.
    return runHighsOptimization(message.offers, message.initialTotals)
      .catch(err => {
        console.error("[Background] Błąd optymalizacji:", err);
        return { error: err.message };
      });
  }
});

async function runHighsOptimization(offers, initialTotals) {
  const highs = await getHighs();

  if (!offers || offers.length === 0) return null;

  const Q = {};
  const baseOffersSeen = new Set();
  for (const o of offers) {
    const pid = o.product_id_group;
    const bid = o.base_offer_id || pid;
    const qty = o.required_quantity || 1;
    if (!baseOffersSeen.has(bid)) {
      baseOffersSeen.add(bid);
      Q[pid] = (Q[pid] || 0) + qty;
    }
  }

  const allProducts = [...new Set(offers.map(o => o.product_id_group))];

  const bestOffers = {};
  for (const o of offers) {
    const key = `${o.product_id_group}|||${o.seller}`;
    if (!bestOffers[key] || o.price < bestOffers[key].price) {
      bestOffers[key] = o;
    }
  }

  // Pre-filter: keep top 15 sellers per product to keep LP size manageable
  const sellersPerProduct = {};
  for (const o of offers) {
    const p = o.product_id_group;
    if (!sellersPerProduct[p]) sellersPerProduct[p] = new Set();
    sellersPerProduct[p].add(o.seller);
  }

  const candidateSellers = {};
  for (const p of allProducts) {
    candidateSellers[p] = [...sellersPerProduct[p]]
      .filter(s => bestOffers[`${p}|||${s}`])
      .sort((a, b) => bestOffers[`${p}|||${a}`].price - bestOffers[`${p}|||${b}`].price)
      .slice(0, 15);
  }

  const activeSellersSet = new Set();
  for (const p of allProducts) {
    candidateSellers[p].forEach(s => activeSellersSet.add(s));
  }
  const activeSellers = [...activeSellersSet];

  const sellerShipping = {};
  for (const s of activeSellers) {
    let mx = 0;
    for (const p of allProducts) {
      const o = bestOffers[`${p}|||${s}`];
      if (o) mx = Math.max(mx, o.shipping_cost ?? 10.49);
    }
    sellerShipping[s] = mx;
  }

  const pIdx = {}; allProducts.forEach((p, i) => pIdx[p] = i);
  const sIdx = {}; activeSellers.forEach((s, i) => sIdx[s] = i);
  const M_total = Object.values(Q).reduce((a, b) => a + b, 0);

  // Build LP String
  let lp = `Minimize\n  obj: `;
  const objTerms = [];
  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      const o = bestOffers[`${p}|||${s}`];
      objTerms.push(`${o.price} x_${pIdx[p]}_${sIdx[s]}`);
    }
  }
  for (const s of activeSellers) {
    objTerms.push(`${sellerShipping[s]} z_${sIdx[s]}`);
  }
  lp += objTerms.join(" + ") + "\n";

  lp += `Subject To\n`;
  for (const p of allProducts) {
    const terms = [];
    for (const s of candidateSellers[p]) {
      terms.push(`x_${pIdx[p]}_${sIdx[s]}`);
    }
    lp += `  req_${pIdx[p]}: ${terms.join(" + ")} = ${Q[p]}\n`;
  }

  for (const s of activeSellers) {
    const termsBuy = [];
    const termsSmart = [`45 y_${sIdx[s]}`, `- 45 z_${sIdx[s]}`];
    
    for (const p of allProducts) {
      if (candidateSellers[p].includes(s)) {
        termsBuy.push(`x_${pIdx[p]}_${sIdx[s]}`);
        const o = bestOffers[`${p}|||${s}`];
        if (o.is_smart) {
          termsSmart.push(`- ${o.price} x_${pIdx[p]}_${sIdx[s]}`);
        }
      }
    }
    
    if (termsBuy.length > 0) {
      lp += `  buy_${sIdx[s]}: ${termsBuy.join(" + ")} - ${M_total} y_${sIdx[s]} <= 0\n`;
      lp += `  smart_${sIdx[s]}: ${termsSmart.join(" ")} <= 0\n`;
    }
  }

  lp += `Bounds\n`;
  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      const o = bestOffers[`${p}|||${s}`];
      const stock = Math.min(o.stock || 999, Q[p]);
      lp += `  0 <= x_${pIdx[p]}_${sIdx[s]} <= ${stock}\n`;
    }
  }
  for (const s of activeSellers) {
    lp += `  0 <= y_${sIdx[s]} <= 1\n`;
    lp += `  0 <= z_${sIdx[s]} <= 1\n`;
  }

  lp += `Generals\n`;
  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      lp += `  x_${pIdx[p]}_${sIdx[s]}\n`;
    }
  }
  for (const s of activeSellers) {
    lp += `  y_${sIdx[s]}\n`;
    lp += `  z_${sIdx[s]}\n`;
  }

  lp += `End\n`;

  console.log(`[Background] Model MILP zbudowany: ${activeSellers.length} sprzedawców. Uruchamianie HiGHS...`);
  
  const startTime = Date.now();
  let sol;
  try {
    sol = highs.solve(lp);
  } catch (err) {
    throw new Error(`Błąd wykonywania HiGHS: ${err.message}`);
  }
  const elapsed = Date.now() - startTime;

  console.log(`[Background] HiGHS zakończył w ${elapsed}ms. Status:`, sol.Status);

  if (sol.Status !== "Optimal") {
    throw new Error(`Solver nie znalazł optymalnego rozwiązania. Status: ${sol.Status}`);
  }

  const assignment = [];
  const sellerStates = {};

  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      const colName = `x_${pIdx[p]}_${sIdx[s]}`;
      const col = sol.Columns[colName];
      if (col && col.Primal > 0.5) {
        const qty = Math.round(col.Primal);
        const o = bestOffers[`${p}|||${s}`];
        assignment.push({
          offer_id: o.offer_id,
          seller: s,
          product_group: p,
          price: o.price,
          is_smart: o.is_smart,
          shipping_cost: o.shipping_cost,
          quantity: qty
        });

        if (!sellerStates[s]) sellerStates[s] = { qtyBought: 0, totalSmartCost: 0, maxShipping: 0, shippingPaid: 0 };
        sellerStates[s].qtyBought += qty;
        if (o.is_smart) sellerStates[s].totalSmartCost += qty * o.price;
        sellerStates[s].maxShipping = Math.max(sellerStates[s].maxShipping, o.shipping_cost ?? 10.49);
      }
    }
  }

  let productCost = 0;
  let shippingCost = 0;
  for (const item of assignment) productCost += item.price * item.quantity;
  for (const s in sellerStates) {
    const st = sellerStates[s];
    st.shippingPaid = st.totalSmartCost >= 45.0 ? 0 : sellerShipping[s];
    shippingCost += st.shippingPaid;
  }

  const totalCost = productCost + shippingCost;
  console.log(`[Background] ✅ MILP: Produkty: ${productCost.toFixed(2)} zł | Dostawa: ${shippingCost.toFixed(2)} zł | RAZEM: ${totalCost.toFixed(2)} zł`);

  return { assignment, productCost, shippingCost, totalCost, sellerStates };
}
