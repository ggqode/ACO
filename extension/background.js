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

    const promise = runHighsOptimization(message.offers, message.initialTotals)
      .catch(err => {
        console.error("[Background] Błąd optymalizacji:", err);
        return { error: err.message };
      });

    if (typeof browser !== 'undefined') {
      return promise; // Firefox MV3
    } else {
      promise.then(sendResponse);
      return true; // Chrome MV3
    }
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
      
    // Zabezpieczenie przed brakiem dostępnych sztuk na całym rynku
    let totalStockAvailable = 0;
    for (const s of candidateSellers[p]) {
      const o = bestOffers[`${p}|||${s}`];
      totalStockAvailable += (o.stock || 999);
    }
    
    if (totalStockAvailable < Q[p]) {
      console.warn(`[Background] UWAGA: Dla produktu ${p} brak wymaganej ilości na rynku. Redukcja z ${Q[p]} na ${totalStockAvailable} szt.`);
      Q[p] = totalStockAvailable;
    }
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
    objTerms.push(`10.49 ship1_${sIdx[s]}`);
    objTerms.push(`10.49 ship2_${sIdx[s]}`);
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
    const termsSmartEligible = [];
    const termsW = [];
    
    for (const p of allProducts) {
      if (candidateSellers[p].includes(s)) {
        // x_sp <= M_total * u_sp
        lp += `  x_u_${pIdx[p]}_${sIdx[s]}: x_${pIdx[p]}_${sIdx[s]} - ${M_total} u_${pIdx[p]}_${sIdx[s]} <= 0\n`;
        
        const o = bestOffers[`${p}|||${s}`];
        if (o.is_smart) {
          termsSmartEligible.push(`${o.price} x_${pIdx[p]}_${sIdx[s]}`);
          // w_sp >= u_sp - smart_qualified_s => w_sp - u_sp + smart_qualified_s >= 0
          lp += `  w_def_${pIdx[p]}_${sIdx[s]}: w_${pIdx[p]}_${sIdx[s]} - u_${pIdx[p]}_${sIdx[s]} + smart_qual_${sIdx[s]} >= 0\n`;
        } else {
          // w_sp >= u_sp => w_sp - u_sp >= 0
          lp += `  w_def_${pIdx[p]}_${sIdx[s]}: w_${pIdx[p]}_${sIdx[s]} - u_${pIdx[p]}_${sIdx[s]} >= 0\n`;
        }
        termsW.push(`w_${pIdx[p]}_${sIdx[s]}`);
      }
    }
    
    // Smart qualification
    if (termsSmartEligible.length > 0) {
      // 45 * smart_qualified_s <= sum(price * x_sp)
      lp += `  smart_cond_${sIdx[s]}: 45 smart_qual_${sIdx[s]} - ${termsSmartEligible.join(" - ")} <= 0\n`;
    } else {
      lp += `  smart_cond_${sIdx[s]}: smart_qual_${sIdx[s]} = 0\n`;
    }
    
    // Shipping tiers
    if (termsW.length > 0) {
      lp += `  ship1_cond_${sIdx[s]}: ${termsW.join(" + ")} - ${allProducts.length} ship1_${sIdx[s]} <= 0\n`;
      lp += `  ship2_cond_${sIdx[s]}: ${termsW.join(" + ")} - ${allProducts.length} ship2_${sIdx[s]} <= 1\n`;
    }
  }

  lp += `Bounds\n`;
  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      const o = bestOffers[`${p}|||${s}`];
      const stock = Math.min(o.stock || 999, Q[p]);
      lp += `  0 <= x_${pIdx[p]}_${sIdx[s]} <= ${stock}\n`;
      lp += `  0 <= u_${pIdx[p]}_${sIdx[s]} <= 1\n`;
      lp += `  0 <= w_${pIdx[p]}_${sIdx[s]} <= 1\n`;
    }
  }
  for (const s of activeSellers) {
    lp += `  0 <= smart_qual_${sIdx[s]} <= 1\n`;
    lp += `  0 <= ship1_${sIdx[s]} <= 1\n`;
    lp += `  0 <= ship2_${sIdx[s]} <= 1\n`;
  }

  lp += `Generals\n`;
  for (const p of allProducts) {
    for (const s of candidateSellers[p]) {
      lp += `  x_${pIdx[p]}_${sIdx[s]}\n`;
      lp += `  u_${pIdx[p]}_${sIdx[s]}\n`;
      lp += `  w_${pIdx[p]}_${sIdx[s]}\n`;
    }
  }
  for (const s of activeSellers) {
    lp += `  smart_qual_${sIdx[s]}\n`;
    lp += `  ship1_${sIdx[s]}\n`;
    lp += `  ship2_${sIdx[s]}\n`;
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
    
    let smartCost = 0;
    let smartProducts = 0;
    let nonSmartCount = 0;
    
    for (const item of assignment) {
      if (item.seller === s) {
        if (item.is_smart) {
          smartCost += item.price * item.quantity;
          smartProducts++;
        } else {
          nonSmartCount++;
        }
      }
    }
    
    let paidProductsCount = 0;
    if (smartCost < 45) {
      paidProductsCount = smartProducts + nonSmartCount;
    } else {
      paidProductsCount = nonSmartCount;
    }
    
    if (paidProductsCount === 0) {
      st.shippingPaid = 0;
    } else if (paidProductsCount === 1) {
      st.shippingPaid = 10.49;
    } else {
      st.shippingPaid = 20.98;
    }
    
    shippingCost += st.shippingPaid;
  }

  const totalCost = productCost + shippingCost;
  console.log(`[Background] ✅ MILP: Produkty: ${productCost.toFixed(2)} zł | Dostawa: ${shippingCost.toFixed(2)} zł | RAZEM: ${totalCost.toFixed(2)} zł`);

  const mergedAssignment = [];
  const assignmentMap = {};

  for (const item of assignment) {
    if (assignmentMap[item.offer_id]) {
      assignmentMap[item.offer_id].quantity += item.quantity;
    } else {
      assignmentMap[item.offer_id] = { ...item };
      mergedAssignment.push(assignmentMap[item.offer_id]);
    }
  }

  return { assignment: mergedAssignment, productCost, shippingCost, totalCost, sellerStates };
}
