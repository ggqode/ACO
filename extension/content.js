/**
 * ACO - Cart Optimizer - Content Script
 *
 * Parametry monetyzacyjne są wczytywane z config.production.js (plik prywatny).
 * Jeśli plik nie istnieje, CONFIG_MONETIZATION zostanie zdefiniowany z pustym PARAMS_SHARE.
 */

// Fallback – jeśli config.production.js nie został załadowany (np. środowisko deweloperskie)
if (typeof CONFIG_MONETIZATION === 'undefined') {
  var CONFIG_MONETIZATION = { PARAMS_SHARE: "" };
}

const DEFAULT_SHIPPING_COST = 10.49;

// Monkey-patch console methods to redirect logs to local storage and the overlay logs panel
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;

function pushAcoLog(prefix, args) {
  const msg = args.map(arg => {
    if (typeof arg === "object") {
      try {
        return JSON.stringify(arg);
      } catch (e) {
        return "[Object]";
      }
    }
    return String(arg);
  }).join(" ");

  const time = new Date().toLocaleTimeString();
  const logLine = `[${time}] ${prefix} ${msg}`;

  chrome.storage.local.get(["aco_logs"], (res) => {
    const logs = res.aco_logs || [];
    logs.push(logLine);
    if (logs.length > 150) logs.shift();
    chrome.storage.local.set({ aco_logs: logs }, () => {
      if (typeof overlay !== 'undefined' && overlay.updateLogsUI) {
        overlay.updateLogsUI(logs);
      }
    });
  });
}

console.log = function (...args) {
  originalLog.apply(console, args);
  pushAcoLog("[INFO]", args);
};

console.warn = function (...args) {
  originalWarn.apply(console, args);
  pushAcoLog("[WARN]", args);
};

console.error = function (...args) {
  originalError.apply(console, args);
  pushAcoLog("[ERROR]", args);
};

// Safely wrap chrome API to handle "Extension context invalidated" gracefully
if (typeof chrome !== 'undefined') {
  const handleInvalidatedContext = () => {
    originalWarn.call(console, "[ACO] Extension context invalidated. Reloading page to update content script...");
    window.location.reload();
  };

  const wrapCallback = (cb) => {
    if (!cb) return cb;
    return (...args) => {
      try {
        cb(...args);
      } catch (err) {
        if (err && err.message && err.message.includes("Extension context invalidated")) {
          handleInvalidatedContext();
        } else {
          throw err;
        }
      }
    };
  };

  const wrapMethod = (target, prop) => {
    if (!target || typeof target[prop] !== 'function') return;
    const orig = target[prop];
    target[prop] = function (...args) {
      try {
        for (let i = 0; i < args.length; i++) {
          if (typeof args[i] === 'function') {
            args[i] = wrapCallback(args[i]);
          }
        }
        return orig.apply(this, args);
      } catch (err) {
        if (err && err.message && err.message.includes("Extension context invalidated")) {
          handleInvalidatedContext();
        } else {
          throw err;
        }
      }
    };
  };

  if (chrome.storage && chrome.storage.local) {
    wrapMethod(chrome.storage.local, 'get');
    wrapMethod(chrome.storage.local, 'set');
    wrapMethod(chrome.storage.local, 'remove');
    wrapMethod(chrome.storage.local, 'clear');
  }
  if (chrome.runtime) {
    wrapMethod(chrome.runtime, 'sendMessage');
  }
}

// Helper to add base delay
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Bezpieczna alternatywa dla element.innerHTML = htmlString.
 * Używa DOMParser, aby sparsować HTML w izolowanym dokumencie
 * (skrypty są tam nieaktywne), a następnie przenosi węzły do
 * docelowego elementu. Eliminuje ostrzeżenie lintera
 * "Unsafe assignment to innerHTML".
 * @param {Element} el - element docelowy
 * @param {string} html - ciąg HTML do wstawienia
 */
function setHTML(el, html) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  el.replaceChildren(...doc.body.childNodes);
}

/**
 * Buduje węzeł DocumentFragment z mieszanego tekstu i tagów <strong>.
 * Bezpieczna alternatywa dla noticeEl.innerHTML = `tekst <strong>...</strong>`.
 * @param {Array<{text: string, bold: boolean}>} parts
 * @returns {DocumentFragment}
 */
function buildMixedText(parts) {
  const frag = document.createDocumentFragment();
  for (const p of parts) {
    if (p.bold) {
      const s = document.createElement("strong");
      s.textContent = p.text;
      frag.appendChild(s);
    } else {
      frag.appendChild(document.createTextNode(p.text));
    }
  }
  return frag;
}

/**
 * Wysyła wiadomość do skryptu tła (background) w sposób kompatybilny
 * z Chrome (Service Worker) i Firefox (background scripts MV3).
 *
 * Firefox MV3 obsługuje zwracanie Promise z onMessage – to bardziej
 * niezawodne niż wzorzec `return true + sendResponse` używany przez Chrome,
 * który może cicho zawieść w Firefox (kanał zamykany przed odpowiedzią).
 *
 * Używa `browser.runtime.sendMessage` (Promise API) jeśli dostępne
 * (Firefox), w przeciwnym razie wraca do `chrome.runtime.sendMessage`
 * z callbackiem (Chrome/Edge/Brave).
 *
 * @param {object} message - obiekt wiadomości
 * @returns {Promise<any>}
 */
function sendMessageAsync(message) {
  // Firefox exposes `browser` (Promise-based) while Chrome uses `chrome` (callback-based).
  // In Firefox, browser.runtime.sendMessage returns a Promise automatically.
  if (typeof browser !== 'undefined' && browser.runtime && browser.runtime.sendMessage) {
    return browser.runtime.sendMessage(message);
  }
  // Chrome / Edge / Brave: wrap callback API in a Promise
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => resolve(response));
  });
}

// -------------------------------------------------------------
// ALLEGRO SHARE – CASHBACK DETECTION & URL BUILDER
// -------------------------------------------------------------

/**
 * Wykrywa obecność popularnych polskich wtyczek cashback/kuponowych w DOM.
 * Sprawdzane wtyczki: LetyShops, ZEN, Picodi, Goodie, AleRabat.
 * @returns {boolean} true jeśli wykryto co najmniej jedną wtyczkę
 */
function checkActiveCashback() {
  const checks = [
    // LetyShops – shadow host lub element z ID/klasą
    () => !!document.querySelector('#letyshops-widget, [id*="letyshops"], [class*="letyshops"], letyshops-widget'),

    // ZEN – wtyczka cashback Zen.com
    () => !!document.querySelector('#zen-cashback-widget, [id*="zen-cashback"], [class*="zen-cashback"], [data-zen]'),

    // Picodi – rozszerzenie kuponowe
    () => !!document.querySelector('#picodi-extension, [id*="picodi"], [class*="picodi"]'),

    // Goodie – polska platforma cashback
    () => !!document.querySelector('#goodie-bar, [id*="goodie"], [class*="goodie-ext"]'),

    // AleRabat – polska wtyczka cashback
    () => !!document.querySelector('#alerabat-widget, [id*="alerabat"], [class*="alerabat"]'),

    // Generyczne znaczniki wstrzykiwane przez wtyczki cashback (atrybut data-*)
    () => !!document.querySelector('[data-cashback-extension], [data-affiliate-ext], [data-cashback-active]'),

    // Sprawdzenie atrybutów na elemencie <html> lub <body> wstrzykiwanych przez extension content scripts
    () => document.documentElement.hasAttribute('data-letyshops') ||
          document.documentElement.hasAttribute('data-goodie') ||
          document.documentElement.hasAttribute('data-alerabat') ||
          document.body.hasAttribute('data-cashback-plugin'),
  ];

  return checks.some(fn => { try { return fn(); } catch (e) { return false; } });
}

/**
 * Buduje finalny URL oferty z opcjonalnymi parametrami afiliacyjnymi.
 * @param {string} offerId  – ID oferty Allegro
 * @param {boolean} withShare – czy dołączyć parametry afiliacyjne
 * @returns {string} pełny URL
 */
function buildOfferUrl(offerId, withShare = false) {
  const base = `https://allegro.pl/oferta/${offerId}`;
  if (withShare && CONFIG_MONETIZATION.PARAMS_SHARE) {
    return base + CONFIG_MONETIZATION.PARAMS_SHARE;
  }
  return base;
}

function normalizeSeller(nameOrHref) {
  if (!nameOrHref) return "nieznany";
  const str = String(nameOrHref).trim();

  if (str.includes("/") || str.includes("\\")) {
    const match = str.match(/\/(uzytkownik|sklep)\/([^/?#]+)/i);
    if (match) {
      return decodeURIComponent(match[2]).trim().toLowerCase();
    }
  }

  let cleanName = str.split("(")[0].trim().toLowerCase();
  return cleanName || "nieznany";
}

function simulateHumanScroll() {
  try {
    const scrollAmt = Math.floor(200 + Math.random() * 350);
    window.scrollTo({
      top: scrollAmt,
      behavior: 'smooth'
    });
  } catch (e) {
    // ignore scroll errors
  }
}

// Wrapper for scrolling based on Safe Mode setting
function runScroll() {
  chrome.storage.local.get(["aco_safe_mode"], (res) => {
    const isSafeMode = res.aco_safe_mode === true;
    if (isSafeMode) {
      simulateHumanScroll();
    }
  });
}

// Wrapper for delay based on Safe Mode setting
function runDelay(safeMs, fastMs = 200) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["aco_safe_mode"], async (res) => {
      const isSafeMode = res.aco_safe_mode === true;
      if (isSafeMode) {
        const randomMs = safeMs + Math.random() * 800;
        await delay(randomMs);
      } else {
        await delay(fastMs);
      }
      resolve();
    });
  });
}


// Wait for a selector to appear in the DOM
function waitForSelector(selector, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const startTime = Date.now();
    const interval = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) {
        clearInterval(interval);
        resolve(el);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        reject(new Error(`Timeout waiting for selector: ${selector}`));
      }
    }, 200);
  });
}

// -------------------------------------------------------------
// IFRAME NAVIGATOR (For silent background operations)
// -------------------------------------------------------------
class IframeNavigator {
  constructor() {
    this.iframe = null;
    this.wrapper = null;
    this.isCaptchaMode = false;
  }

  createHiddenIframe(url) {
    this.destroy(); 
    
    this.wrapper = document.createElement("div");
    this.wrapper.id = "aco-captcha-iframe-wrapper";
    this.wrapper.style.position = "fixed";
    this.wrapper.style.width = "1280px";
    this.wrapper.style.height = "1024px";
    this.wrapper.style.left = "0px";
    this.wrapper.style.top = "0px";
    this.wrapper.style.opacity = "0.001";
    this.wrapper.style.pointerEvents = "none";
    this.wrapper.style.overflow = "hidden";
    this.wrapper.style.zIndex = "-9999";

    this.iframe = document.createElement("iframe");
    this.iframe.src = url;
    this.iframe.style.width = "100%";
    this.iframe.style.height = "100%";
    this.iframe.style.border = "none";
    
    this.wrapper.appendChild(this.iframe);
    document.body.appendChild(this.wrapper);
    
    return this.iframe;
  }

  revealAsCaptchaModal() {
    this.isCaptchaMode = true;
    if (this.wrapper) {
      this.wrapper.className = "aco-captcha-visible";
      this.wrapper.style.position = "fixed";
      this.wrapper.style.width = "400px";
      this.wrapper.style.height = "550px";
      this.wrapper.style.top = "50%";
      this.wrapper.style.left = "50%";
      this.wrapper.style.transform = "translate(-50%, -50%)";
      this.wrapper.style.zIndex = "9999999";
      this.wrapper.style.visibility = "visible";
      this.wrapper.style.display = "block";
      this.wrapper.style.backgroundColor = "#fff";
      this.wrapper.style.boxShadow = "0 10px 40px rgba(0,0,0,0.6)";
      this.wrapper.style.borderRadius = "8px";
      this.wrapper.style.overflow = "hidden";
      this.wrapper.style.opacity = "1";
      this.wrapper.style.pointerEvents = "auto";
      
      if (!document.getElementById("aco-captcha-header")) {
        const header = document.createElement("div");
        header.id = "aco-captcha-header";
        header.className = "aco-captcha-header";
        header.innerHTML = `
          <div style="background: #ff5a00; color: white; padding: 12px; font-weight: bold; text-align: center; font-family: sans-serif; font-size: 14px;">
            Potwierdź, że jesteś człowiekiem, aby ACO mogło kontynuować
          </div>
        `;
        this.wrapper.insertBefore(header, this.iframe);
        this.iframe.style.height = "calc(100% - 44px)";
      }
    }
  }

  hideAgain() {
    this.isCaptchaMode = false;
    if (this.wrapper) {
      this.wrapper.className = "";
      this.wrapper.style.position = "fixed";
      this.wrapper.style.width = "1280px";
      this.wrapper.style.height = "1024px";
      this.wrapper.style.left = "0px";
      this.wrapper.style.top = "0px";
      this.wrapper.style.opacity = "0.001";
      this.wrapper.style.pointerEvents = "none";
      this.wrapper.style.overflow = "hidden";
      this.wrapper.style.zIndex = "-9999";
      
      const header = document.getElementById("aco-captcha-header");
      if (header) header.remove();
      this.iframe.style.height = "100%";
    }
  }

  destroy() {
    if (this.wrapper) {
      this.wrapper.remove();
      this.wrapper = null;
      this.iframe = null;
    }
  }

  waitForLoad(timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
      if (!this.iframe) return reject(new Error("Iframe not created"));
      
      const timer = setTimeout(() => {
        reject(new Error("Iframe load timeout"));
      }, timeoutMs);
      
      this.iframe.onload = () => {
        clearTimeout(timer);
        resolve();
      };
    });
  }
}

const iframeNav = new IframeNavigator();

// -------------------------------------------------------------
// OVERLAY MANAGER (Renders progress and summary widgets)

// -------------------------------------------------------------
class ACOOverlay {
  constructor() {
    this.container = null;
  }

  init() {
    if (document.getElementById("aco-overlay")) return;

    this.container = document.createElement("div");
    this.container.id = "aco-overlay";
    this.container.className = "aco-overlay-container";

    // Inject the widget
    document.body.appendChild(this.container);

    // Force reflow and show
    setTimeout(() => {
      this.container.classList.add("aco-visible");
    }, 100);
  }

  destroy() {
    if (this.container) {
      this.container.classList.remove("aco-visible");
      setTimeout(() => {
        this.container.remove();
      }, 400);
    }
  }

  setupLogsToggle() {
    const toggleBtn = document.getElementById("aco-toggle-logs");
    const panel = document.getElementById("aco-logs-panel");
    if (toggleBtn && panel) {
      // Restore expanded state if saved
      chrome.storage.local.get(["aco_logs_expanded"], (res) => {
        if (res.aco_logs_expanded) {
          panel.className = "aco-logs-panel-expanded";
          toggleBtn.textContent = "Ukryj Dziennik Zdarzeń (Logi) ▲";
        }
      });

      toggleBtn.onclick = () => {
        const isCollapsed = panel.className === "aco-logs-panel-collapsed";
        panel.className = isCollapsed ? "aco-logs-panel-expanded" : "aco-logs-panel-collapsed";
        toggleBtn.textContent = isCollapsed ? "Ukryj Dziennik Zdarzeń (Logi) ▲" : "Pokaż Dziennik Zdarzeń (Logi) ▼";
        chrome.storage.local.set({ aco_logs_expanded: isCollapsed });
        if (isCollapsed) {
          const content = document.getElementById("aco-logs-content");
          if (content) content.scrollTop = content.scrollHeight;
        }
      };
    }

    // Load initial logs
    chrome.storage.local.get(["aco_logs"], (res) => {
      this.updateLogsUI(res.aco_logs || []);
    });
  }

  updateLogsUI(logs) {
    const content = document.getElementById("aco-logs-content");
    if (content) {
      content.replaceChildren(...logs.map(line => {
        let lineClass = "aco-log-info";
        if (line.includes("[ERROR]") || line.includes("błąd") || line.includes("Błąd") || line.includes("failed")) {
          lineClass = "aco-log-error";
        } else if (line.includes("[WARN]") || line.includes("warning") || line.includes("ostrzeżenie")) {
          lineClass = "aco-log-warn";
        } else if (line.includes("Optymaliz") || line.includes("Solver") || line.includes("cheapest") || line.includes("Zaoszczędzona")) {
          lineClass = "aco-log-success";
        }
        const div = document.createElement("div");
        div.className = `aco-log-line ${lineClass}`;
        div.textContent = line;
        return div;
      }));
      content.scrollTop = content.scrollHeight;
    }
  }

  showWorking(stageName, percent, progressText, itemName) {
    this.init();

    let itemHtml = "";
    if (itemName) {
      itemHtml = `
        <div class="aco-item-details">
          <div class="aco-item-label">Aktualnie przetwarzany produkt:</div>
          <div class="aco-item-value">${itemName}</div>
        </div>
      `;
    }

    setHTML(this.container, `
      <div class="aco-overlay-header">
        <img src="${chrome.runtime.getURL("icons/logo.png")}" alt="ACO Logo" class="aco-overlay-logo">
        <div class="aco-overlay-header-text">
          <h3>ACO - Cart Optimizer</h3>
          <span>Automatyczna optymalizacja...</span>
        </div>
      </div>
      <div class="aco-overlay-content">
        <div class="aco-overlay-stage">
          <span>Etap: ${stageName}</span>
          <div class="aco-overlay-spinner"></div>
        </div>
        <div class="aco-progress-wrapper">
          <div class="aco-progress-track">
            <div class="aco-progress-bar" style="width: ${percent}%"></div>
          </div>
          <div class="aco-progress-text">
            <span>Postęp</span>
            <span>${progressText}</span>
          </div>
        </div>
        ${itemHtml}
        <div class="aco-warning-banner">
          ⚠️ <strong>Nie zamykaj i nie przełączaj tej karty.</strong> Praca w tle spowalnia proces przez oszczędzanie energii przeglądarki.
        </div>
        <!-- Logs Panel Toggle Button -->
        <button id="aco-toggle-logs" class="aco-logs-toggle-btn">Pokaż Dziennik Zdarzeń (Logi) ▼</button>
        <div id="aco-logs-panel" class="aco-logs-panel-collapsed">
          <div id="aco-logs-content" class="aco-logs-content">Wczytywanie logów...</div>
        </div>
      </div>
    `);
    this.setupLogsToggle();
  }

  showSummary(results, initial, optimizedList, stats, initialList = [], isPreview = false, finalTotals = null) {
    this.init();

    // Defensive price formatting helper
    const fmt = (val) => {
      if (typeof val === "number" && !isNaN(val)) return val.toFixed(2);
      const parsed = parseFloat(val);
      return !isNaN(parsed) ? parsed.toFixed(2) : "0.00";
    };

    // Support both new (productCost/shippingCost) and old (prodCost/shipCost) keys to prevent cache errors
    const prodCostBefore = initial.products_cost || 0;
    const prodCostAfter = (results.productCost ?? results.prodCost) || 0;

    const shipCostBefore = initial.shipping_cost || 0;
    const shipCostAfter = (results.shippingCost ?? results.shipCost) || 0;

    const totalCostBefore = initial.total_cost || 0;
    const totalCostAfter = results.totalCost || 0;

    const savedAmount = isPreview 
      ? Math.max(0, totalCostBefore - totalCostAfter)
      : (finalTotals ? Math.max(0, totalCostBefore - finalTotals.total_cost) : Math.max(0, totalCostBefore - totalCostAfter));

    // Calculate initial sellers and shipments count from initialList
    const initialSellers = new Set(initialList.map(o => o.seller || "Nieznany"));
    const sellersBefore = initialSellers.size;

    // Group initial items by seller to check if they have shipping costs
    const initialSellersMap = {};
    initialList.forEach(item => {
      const s = item.seller || "Nieznany";
      if (!initialSellersMap[s]) {
        initialSellersMap[s] = {
          shipping_cost: item.shipping_cost || 0.0
        };
      } else {
        initialSellersMap[s].shipping_cost = Math.max(initialSellersMap[s].shipping_cost, item.shipping_cost || 0.0);
      }
    });

    const shipmentsBefore = Object.values(initialSellersMap).filter(s => s.shipping_cost > 0).length;

    const sellerStates = results.sellerStates || {};
    const sellersAfter = Object.keys(sellerStates).filter(s => sellerStates[s].qtyBought > 0).length;
    const shipmentsAfter = Object.keys(sellerStates).filter(s => {
      const state = sellerStates[s];
      return state.qtyBought > 0 && (state.shippingPaid > 0 || (typeof state.shippingPaid === 'undefined' && state.totalSmartCost < 45.0));
    }).length;

    // Stats variables
    const statOptCount = stats.total_optimizations || 0;
    const statTotalSaved = stats.total_saved || 0;
    const statAvgSaved = stats.average_saved || 0;
    const statMaxSaved = stats.max_single_saved || 0;

    setHTML(this.container, `
      <div class="aco-overlay-header">
        <img src="${chrome.runtime.getURL("icons/logo.png")}" alt="ACO Logo" class="aco-overlay-logo">
        <div class="aco-overlay-header-text">
          <h3>${isPreview ? "Podgląd optymalizacji" : "Optymalizacja ukończona"}</h3>
          <span>${isPreview ? "Zatwierdź lub anuluj zmiany" : "Twój koszyk został zaktualizowany"}</span>
        </div>
      </div>
      <div class="aco-overlay-content">
        <div class="aco-summary-savings">
          <div class="aco-savings-label">Zaoszczędzona kwota:</div>
          <div class="aco-savings-value">${fmt(savedAmount)} zł</div>
        </div>

        <table class="aco-summary-table">
          <thead>
            <tr>
              <th>Metryka</th>
              <th>Przed</th>
              <th>${isPreview ? "Przewidywane" : "Przewidywane"}</th>
              ${!isPreview && finalTotals ? "<th>Finalnie</th>" : ""}
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Produkty</td>
              <td>${fmt(prodCostBefore)} zł</td>
              <td>${fmt(prodCostAfter)} zł</td>
              ${!isPreview && finalTotals ? `<td>${fmt(finalTotals.products_cost)} zł</td>` : ""}
            </tr>
            <tr>
              <td>Dostawa</td>
              <td>${fmt(shipCostBefore)} zł</td>
              <td>${fmt(shipCostAfter)} zł</td>
              ${!isPreview && finalTotals ? `<td>${fmt(finalTotals.shipping_cost)} zł</td>` : ""}
            </tr>
            <tr>
              <td>Suma razem</td>
              <td><strong>${fmt(totalCostBefore)} zł</strong></td>
              <td><strong>${fmt(totalCostAfter)} zł</strong></td>
              ${!isPreview && finalTotals ? `<td><strong>${fmt(finalTotals.total_cost)} zł</strong></td>` : ""}
            </tr>
            <tr>
              <td>Sprzedawcy</td>
              <td>${sellersBefore}</td>
              <td ${!isPreview && finalTotals ? 'colspan="2"' : ''}>${sellersAfter}</td>
            </tr>
            <tr>
              <td>Płatne przesyłki</td>
              <td>${shipmentsBefore}</td>
              <td ${!isPreview && finalTotals ? 'colspan="2"' : ''}>${shipmentsAfter}</td>
            </tr>
          </tbody>
        </table>

        <!-- User Statistics – tylko na ekranie ukończenia -->
        ${!isPreview ? `
        <div class="aco-stats-box">
          <div class="aco-stats-title">Twoje statystyki oszczędności</div>
          <div class="aco-stats-row">
            <span>Wykonane optymalizacje:</span>
            <span>${statOptCount}</span>
          </div>
          <div class="aco-stats-row">
            <span>Łączne oszczędności:</span>
            <span>${fmt(statTotalSaved)} zł</span>
          </div>
          <div class="aco-stats-row">
            <span>Średnia oszczędność:</span>
            <span>${fmt(statAvgSaved)} zł</span>
          </div>
          <div class="aco-stats-row">
            <span>Największa oszczędność:</span>
            <span>${fmt(statMaxSaved)} zł</span>
          </div>
        </div>
        ` : ``}

        ${isPreview ? `
        <div class="aco-share-section">
          <div class="aco-share-title">📦 Akceptuj koszyk</div>
          <div style="font-size: 10px; text-align: center; color: #a0a0a0; margin: 4px 0;">Opcja "Z poleceniem" korzysta z programu afiliacyjnego Allegro Share.</div>
          <div id="aco-cashback-notice" class="aco-cashback-notice"></div>
          <div class="aco-share-buttons">
            <button id="aco-apply-with-share" class="aco-close-btn aco-btn-share-yes" title="Zastosuj koszyk – oferty otwarte przez link z poleceniem autora">
              🤝 Z poleceniem
            </button>
            <button id="aco-apply-no-share" class="aco-close-btn aco-btn-share-no" title="Zastosuj koszyk – standardowe URL ofert, Twój cashback zostaje">
              🔒 Bez polecenia
            </button>
          </div>
          <button id="aco-cancel-optimization" class="aco-close-btn" style="background-color: #333; color: #ff5a00; border: 1px solid #ff5a00; margin-top: 8px; box-shadow: none;">Anuluj optymalizację</button>
        </div>
        ` : `
        <button id="aco-confirm-close" class="aco-close-btn">Zamknij i zakończ</button>
        `}
      </div>

      <div class="aco-os-footer">
        <div class="aco-os-text">ACO jest darmowym projektem Open Source.</div>
        <div class="aco-os-buttons">
          <a href="https://buycoffee.to/ggqode" target="_blank" class="aco-os-btn aco-os-coffee">☕ Wesprzyj na buycoffee.to</a>
          <a href="https://github.com/ggqode" target="_blank" class="aco-os-btn aco-os-github">⭐ GitHub</a>
        </div>
        <div class="aco-os-sig">Created by <span>GGQode</span> ❤️</div>
      </div>
      <!-- Logs Panel Toggle Button -->
      <button id="aco-toggle-logs" class="aco-logs-toggle-btn">Pokaż Dziennik Zdarzeń (Logi) ▼</button>
      <div id="aco-logs-panel" class="aco-logs-panel-collapsed">
        <div id="aco-logs-content" class="aco-logs-content">Wczytywanie logów...</div>
      </div>
    `);

    this.setupLogsToggle();

    if (isPreview) {
      // -------------------------------------------------------
      // Wypełnij komunikat o cashbacku
      // -------------------------------------------------------
      const cashbackDetected = checkActiveCashback();
      const noticeEl = document.getElementById("aco-cashback-notice");
      if (noticeEl) {
        if (cashbackDetected) {
          noticeEl.className = "aco-cashback-notice aco-cashback-detected";
          noticeEl.replaceChildren(buildMixedText([
            { text: "\u26A0\uFE0F ", bold: false },
            { text: "Wykryto aktywną wtyczkę cashback", bold: true },
            { text: " (np. AleRabat, LetyShops, Goodie). Aby zachować swój własny zwrot, wybierz opcję ", bold: false },
            { text: '"bez polecania"', bold: true },
            { text: ".", bold: false }
          ]));
        } else {
          noticeEl.className = "aco-cashback-notice aco-cashback-info";
          noticeEl.replaceChildren(buildMixedText([
            { text: "\u2139\uFE0F Jeśli posiadasz aktywny cashback w przeglądarce, skorzystaj z opcji ", bold: false },
            { text: '"bez polecenia"', bold: true },
            { text: ", aby go nie utracić.", bold: false }
          ]));
        }
      }

      // -------------------------------------------------------
      // Przycisk: Z poleceniem
      // -------------------------------------------------------
      document.getElementById("aco-apply-with-share").addEventListener("click", () => {
        const hasCashback = checkActiveCashback();
        if (hasCashback) {
          const confirmed = window.confirm(
            "Wykryto aktywną wtyczkę cashback w Twojej przeglądarce.\n" +
            "Czy na pewno chcesz skorzystać z mojego polecenia i przejść do koszyka?\n\n" +
            "Kliknij OK, aby kontynuować z poleceniem.\n" +
            "Kliknij Anuluj, aby wrócić i wybrać opcję \"bez polecenia\"."
          );
          if (!confirmed) return;
        }
        // Zapisz flagę – koszyk będzie odtwarzany z parametrami share
        chrome.storage.local.set({ aco_use_share: true, aco_state: "clearing_cart" }, () => {
          handleStateAction();
        });
      });

      // -------------------------------------------------------
      // Przycisk: Bez polecenia
      // -------------------------------------------------------
      document.getElementById("aco-apply-no-share").addEventListener("click", () => {
        chrome.storage.local.set({ aco_use_share: false, aco_state: "clearing_cart" }, () => {
          handleStateAction();
        });
      });

      document.getElementById("aco-cancel-optimization").addEventListener("click", () => {
        chrome.storage.local.set({ aco_state: "idle" }, () => {
          this.destroy();
        });
      });
    } else {
      document.getElementById("aco-confirm-close").addEventListener("click", () => {
        chrome.storage.local.set({ aco_state: "idle" }, () => {
          this.destroy();
        });
      });
    }
  }

  showError(message) {
    this.init();
    setHTML(this.container, `
      <div class="aco-overlay-header">
        <img src="${chrome.runtime.getURL("icons/logo.png")}" alt="ACO Logo" class="aco-overlay-logo">
        <div class="aco-overlay-header-text">
          <h3>Błąd optymalizacji</h3>
          <span>ACO napotkał problem</span>
        </div>
      </div>
      <div class="aco-overlay-content">
        <div style="font-size:12px; color:#ff6666; line-height:1.5; padding:10px; background:rgba(255,0,0,0.1); border-radius:8px;">
          ${message}
        </div>
        <button id="aco-error-close" class="aco-close-btn">Resetuj stan</button>
        <!-- Logs Panel Toggle Button -->
        <button id="aco-toggle-logs" class="aco-logs-toggle-btn">Pokaż Dziennik Zdarzeń (Logi) ▼</button>
        <div id="aco-logs-panel" class="aco-logs-panel-collapsed">
          <div id="aco-logs-content" class="aco-logs-content">Wczytywanie logów...</div>
        </div>
      </div>
    `);
    this.setupLogsToggle();
    document.getElementById("aco-error-close").addEventListener("click", () => {
      chrome.storage.local.set({ aco_state: "idle" }, () => {
        this.destroy();
      });
    });
  }

  showInfo(title, subtitle, message) {
    this.init();
    setHTML(this.container, `
      <div class="aco-overlay-header">
        <img src="${chrome.runtime.getURL("icons/logo.png")}" alt="ACO Logo" class="aco-overlay-logo">
        <div class="aco-overlay-header-text">
          <h3>${title}</h3>
          <span>${subtitle}</span>
        </div>
      </div>
      <div class="aco-overlay-content">
        <div style="font-size:14px; color:#4CAF50; line-height:1.5; padding:15px; background:rgba(76, 175, 80, 0.1); border-radius:8px; border: 1px solid #4CAF50;">
          ${message}
        </div>
        <button id="aco-info-close" class="aco-close-btn" style="margin-top: 15px;">Zamknij</button>
      </div>
    `);
    document.getElementById("aco-info-close").addEventListener("click", () => {
      chrome.storage.local.set({ aco_state: "idle" }, () => {
        this.destroy();
      });
    });
  }
}

// -------------------------------------------------------------
// REACT INPUT SETTER (HACK)
// -------------------------------------------------------------
// Bypass React's controlled input to forcefully set a value
function setReactInputValue(input, value) {
  const strValue = String(value);
  
  // Native setter bypass
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  if (nativeInputValueSetter) {
    nativeInputValueSetter.call(input, strValue);
  } else {
    input.value = strValue;
  }
  
  // React 16+ tracker bypass
  const tracker = input._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }
  
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
}

const overlay = new ACOOverlay();

// -------------------------------------------------------------
// STATE MACHINE ROUTING AND ACTIONS
// -------------------------------------------------------------
function handleStateAction() {
  console.log("[ACO] Inicjalizacja skryptu zawartości...");
  chrome.storage.local.get((data) => {
    if (chrome.runtime.lastError) {
      console.error("[ACO] Błąd odczytu storage:", chrome.runtime.lastError);
      return;
    }
    runStateAction(data).catch(err => {
      console.error("[ACO] Błąd maszyny stanów:", err);
      overlay.showError(err.message);
    });
  });
}

async function runStateAction(data) {
  const state = data.aco_state || "idle";
  console.log("[ACO] Stan maszyny ACO:", state);

  if (state === "idle") {
    return; // Do nothing if inactive
  }

  console.log("[ACO] Uruchamianie kroku dla stanu:", state);

  if (state === "scraping_cart") {
    overlay.showWorking("Pobieranie koszyka", 10, "Odczytywanie zawartości...", "Koszyk Allegro");
    await runDelay(2000, 200); // Allow DOM content to settle
    await runScrapeCart();
  }
  else if (state === "optimizing") {
    overlay.showWorking("Optymalizacja", 90, "Uruchamianie algorytmu...", "Branch-and-Bound");
    await runDelay(1000, 100);
    await runOptimization(data);
  }
  else if (state === "clearing_cart") {
    overlay.showWorking("Czyszczenie koszyka", 95, "Usuwanie starych pozycji...", "Koszyk Allegro");
    await runDelay(1500, 100);
    await runClearCart();
  }
  else if (state === "scraping_alternatives") {
    // Handled reactively by scrapeAlternativesViaIframe() postMessage system
    // If we land here on boot, resume from current index
    chrome.storage.local.get(["aco_cart_items", "aco_current_item_index"], async (res) => {
      const cart = res.aco_cart_items || [];
      const idx = res.aco_current_item_index || 0;
      if (idx < cart.length) {
        const progress = Math.round((idx / cart.length) * 100);
        overlay.showWorking(
          `Analiza ofert (${idx + 1}/${cart.length})`,
          progress,
          `Przedmiot ${idx + 1} z ${cart.length}`,
          cart[idx].title || cart[idx].offer_id
        );
        await runDelay(500, 100);
        scrapeAlternativesViaIframe(cart[idx], idx, cart.length);
      } else {
        chrome.storage.local.set({ aco_state: "optimizing" }, () => handleStateAction());
      }
    });
    return;
  }
  else if (state === "recreating_cart") {
    const optList = data.aco_optimized_list || [];
    const useShare = data.aco_use_share === true;
    
    overlay.showWorking("Aktualizacja koszyka", 0, "Przygotowywanie...", "Uruchamianie cichej odbudowy");
    await runSilentCartRebuild(optList, useShare);
  }
  else if (state === "recreating_cart_fallback") {
    // FALLBACK: Odbudowa koszyka klasyczną metodą redirectów
    const idx = data.aco_current_recreate_index || 0;
    const optList = data.aco_optimized_list || [];
    const useShare = data.aco_use_share === true;

    if (idx < optList.length) {
      const item = optList[idx];
      const progress = Math.round((idx / optList.length) * 100);
      overlay.showWorking(
        `Aktualizacja koszyka (${idx + 1}/${optList.length}) [TRYB KLASYCZNY]`,
        progress,
        `Dodawanie ${idx + 1} z ${optList.length}`,
        `Oferta ID: ${item.offer_id} (${item.quantity} szt.)`
      );

      const currentUrl = window.location.href;
      if (currentUrl.includes(item.offer_id)) {
        runScroll();
        await runDelay(1200, 200);
        await runAddToCartFallback(item, idx, optList.length, useShare);
      } else {
        console.warn("[ACO] Displaced from offer page. Navigating back...");
        window.location.href = buildOfferUrl(item.offer_id, useShare);
      }
    } else {
      chrome.storage.local.set({
        aco_state: "recreating_cart",
        aco_current_recreate_index: optList.length
      }, () => {
        window.location.href = "https://allegro.pl/koszyk";
      });
    }
  }
  else if (state === "preview") {
    const results = data.aco_optimized_results;
    const initial = data.aco_initial_totals;
    const optList = data.aco_optimized_list || [];
    const stats = data.aco_stats || {
      total_optimizations: 0,
      total_saved: 0.0,
      average_saved: 0.0,
      max_single_saved: 0.0
    };

    if (results && initial) {
      overlay.showSummary(results, initial, optList, stats, data.aco_cart_items || [], true);
    } else {
      overlay.showError("Brak danych podsumowania w pamięci lokalnej.");
    }
  }
  else if (state === "completed") {
    const results = data.aco_optimized_results;
    const initial = data.aco_initial_totals;
    const finalTotals = data.aco_final_totals;
    const optList = data.aco_optimized_list || [];
    const stats = data.aco_stats || {
      total_optimizations: 0,
      total_saved: 0.0,
      average_saved: 0.0,
      max_single_saved: 0.0
    };

    if (results && initial) {
      overlay.showSummary(results, initial, optList, stats, data.aco_cart_items || [], false, finalTotals);
    } else {
      overlay.showError("Brak danych podsumowania w pamięci lokalnej.");
    }
  }
}

// -------------------------------------------------------------
// STEP 1: SCRAPE CART ITEMS
// -------------------------------------------------------------

async function runScrapeCart() {
  console.log("[ACO] Scraping cart elements...");
  try {
    // Wait for at least one remove button to ensure cart page items are loaded
    await waitForSelector("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot'], button[aria-label*='Usuń z koszyka']", 15000);
  } catch (err) {
    console.error("[ACO] No remove buttons found in DOM:", err.message);
    overlay.showError("Nie znaleziono przedmiotów w koszyku. Dodaj produkty przed optymalizacją.");
    return;
  }

  // Scrape initial totals
  const initialTotals = extractInitialTotals();

  // Scrape cart offers
  const cartOffers = {};
  const removeButtons = document.querySelectorAll("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot'], button[aria-label*='Usuń z koszyka']");

  removeButtons.forEach(btn => {
    let row = btn.closest("section") || btn.closest("div[data-box-name='cart-item']") || btn.closest("li") || btn.parentElement;
    while (row && row.tagName !== "BODY") {
      if (row.querySelector("a[href*='/oferta/']")) {
        break;
      }
      row = row.parentElement;
    }

    if (!row || row === document.body) return;

    // Find the offer link inside this container
    const link = row.querySelector("a[href*='/oferta/']");
    if (!link) return;

    const href = link.getAttribute("href") || "";
    const match = href.match(/\/oferta\/.*?-?(\d{8,14})/);
    if (!match) return;
    const offerId = match[1];

    if (!cartOffers[offerId]) {
      let quantity = 1;
      let title = "Produkt Allegro";
      let price = 0.0;
      let isSmart = false;
      let seller = "Nieznany";
      let shippingCost = 0.0;

      if (row && row !== document.body) {
        // Quantity - szukamy inputa z aria-label='Quantity input field', przesuwajac sie w gore DOM
        {
          let curr = link;
          let foundQty = false;
          for (let lvl = 0; lvl < 6 && curr; lvl++) {
            const qtyInput = curr.querySelector("input[aria-label='Quantity input field']");
            if (qtyInput) {
              const parsed = parseInt(qtyInput.value);
              if (!isNaN(parsed) && parsed > 0) {
                quantity = parsed;
                foundQty = true;
              }
              break;
            }
            curr = curr.parentElement;
          }
          // fallback - standardowe inputy tekstowe/number
          if (!foundQty && row && row !== document.body) {
            const qtyInput = row.querySelector("input[type='number']") || row.querySelector("input[type='text']");
            if (qtyInput) {
              quantity = parseInt(qtyInput.value) || 1;
            }
          }
        }

        // Title
        const titleEl = row.querySelector("h2, a[href*='/oferta/'] span, a[href*='/oferta/']");
        if (titleEl) {
          title = titleEl.innerText.trim();
        }

        // Price (Divide total row price by quantity to get the correct unit price)
        const rowText = row.innerText || "";
        const priceMatch = rowText.match(/([\d\s]+[.,]\d{2})\s*zł/);
        if (priceMatch) {
          const totalRowPrice = parseFloat(priceMatch[1].replace(/\s/g, "").replace(",", ".")) || 0.0;
          price = quantity > 0 ? (totalRowPrice / quantity) : totalRowPrice;
        }

        // Seller and Group container (Traverse up to find the common container that has the seller link)
        let sellerLink = row.querySelector("a[href*='/uzytkownik/'], a[href*='/sklep/']");
        let groupContainer = row;

        if (!sellerLink) {
          let curr = row.parentElement;
          while (curr && curr.tagName !== "BODY") {
            const found = curr.querySelector("a[href*='/uzytkownik/'], a[href*='/sklep/']");
            if (found) {
              sellerLink = found;
              groupContainer = curr;
              break;
            }
            curr = curr.parentElement;
          }
        }

        if (sellerLink) {
          const href = sellerLink.getAttribute("href") || "";
          seller = normalizeSeller(href || sellerLink.innerText);
        } else {
          seller = `sprzedawca_nieznany`;
        }

        // Smart and shipping extraction for the section container
        let sectionShipping = 0.0;
        let sectionSmart = rowText.toLowerCase().includes("smart");

        if (groupContainer) {
          const secText = groupContainer.innerText || "";
          const secTextLower = secText.toLowerCase();

          if (secTextLower.includes("smart")) {
            sectionSmart = true;
          }

          if (secTextLower.includes("darmowa dostawa") || secTextLower.includes("dostawa 0") || secTextLower.includes("bezpłatna")) {
            sectionShipping = 0.0;
            sectionSmart = true;
          } else {
            // Find delivery price in this section
            const lines = secText.split("\n");
            for (const line of lines) {
              const lineLower = line.toLowerCase();
              if (lineLower.includes("dostawa") || lineLower.includes("wysyłka") || lineLower.includes("przesyłka") || lineLower.includes("kurier") || lineLower.includes("paczkomat")) {
                const match = line.match(/([\d\s]+[.,]\d{2})/);
                if (match) {
                  sectionShipping = parseFloat(match[1].replace(/\s/g, "").replace(",", ".")) || 0.0;
                  break;
                }
              }
            }
          }
        }

        isSmart = sectionSmart;
        shippingCost = sectionShipping;
      }

      cartOffers[offerId] = {
        original_url: href,
        offer_id: offerId,
        quantity: quantity,
        price: price,
        is_smart: isSmart,
        shipping_cost: shippingCost,
        seller: seller,
        title: title,
        product_id_group: offerId // Fallback group
      };
    }
  });

  const cartList = Object.values(cartOffers);
  console.log(`[ACO] Scraped ${cartList.length} items from cart:`, cartList);

  if (cartList.length === 0) {
    overlay.showError("Nie udało się odczytać żadnych produktów z koszyka.");
    return;
  }

  // Zapisz początkowe koszyki
  chrome.storage.local.set({
    aco_cart_items: cartList,
    aco_initial_totals: initialTotals,
    aco_all_offers: []
  });

  // Przełącz na scraping alternatyw przez ukryty iframe
  const first = cartList[0];
  chrome.storage.local.set({
    aco_all_offers: [],
    aco_current_item_index: 0,
    aco_state: "scraping_alternatives"
  }, async () => {
    await runDelay(800, 100);
    scrapeAlternativesViaIframe(first, 0, cartList.length);
  });
}

// Scrape alternatives for one item using a hidden iframe
function scrapeAlternativesViaIframe(item, index, totalItems) {
  const url = `https://allegro.pl/oferta/${item.offer_id}?order=p&buyNew=1&offerTypeBuyNow=1&p=1#inne-oferty-produktu`;
  console.log(`[ACO] Scraping alternatives for ${item.offer_id} via hidden iframe...`);

  const iframe = iframeNav.createHiddenIframe(url);
  let resolved = false;
  let timeoutTimer = null;

  const onMessage = (e) => {
    if (!e.data || typeof e.data !== "object") return;

    if (e.data.type === "ACO_CAPTCHA_DETECTED") {
      iframeNav.revealAsCaptchaModal();
      if (timeoutTimer) {
        clearTimeout(timeoutTimer);
        timeoutTimer = null;
        console.warn("[ACO] CAPTCHA detected. Scrape timeout paused.");
      }
    } else if (e.data.type === "ACO_CAPTCHA_SOLVED") {
      iframeNav.hideAgain();
    } else if (e.data.type === "ACO_ALTERNATIVES_SCRAPED") {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      window.removeEventListener("message", onMessage);
      iframeNav.destroy();

      const offersList = e.data.offers || [];
      console.log(`[ACO] Received ${offersList.length} alternatives for ${item.offer_id}`);

      chrome.storage.local.get(["aco_all_offers", "aco_cart_items"], (res) => {
        const all = res.aco_all_offers || [];
        const updated = all.concat(offersList);
        const nextIdx = index + 1;
        const cart = res.aco_cart_items || [];

        const progress = Math.round((nextIdx / totalItems) * 100);
        overlay.showWorking(
          `Analiza ofert (${nextIdx}/${totalItems})`,
          progress,
          `Przeanalizowano ${nextIdx} z ${totalItems}`,
          cart[nextIdx] ? (cart[nextIdx].title || cart[nextIdx].offer_id) : "Zakończono"
        );

        chrome.storage.local.set({
          aco_all_offers: updated,
          aco_current_item_index: nextIdx
        }, async () => {
          if (nextIdx < cart.length) {
            await runDelay(1000, 200);
            scrapeAlternativesViaIframe(cart[nextIdx], nextIdx, totalItems);
          } else {
            chrome.storage.local.set({ aco_state: "optimizing" }, () => {
              handleStateAction();
            });
          }
        });
      });
    } else if (e.data.type === "ACO_SCRAPE_FAILED") {
      if (resolved) return;
      resolved = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      window.removeEventListener("message", onMessage);
      iframeNav.destroy();

      console.error(`[ACO] Iframe scrape failed for ${item.offer_id}, using fallback`);
      const fallback = [{
        product_id_group: item.offer_id,
        base_offer_id: item.offer_id,
        offer_id: item.offer_id,
        seller: item.seller || "Nieznany",
        price: item.price || 9999.0,
        is_smart: item.is_smart || false,
        shipping_cost: item.shipping_cost || DEFAULT_SHIPPING_COST,
        stock: 999,
        required_quantity: item.quantity
      }];

      chrome.storage.local.get(["aco_all_offers", "aco_cart_items"], (res) => {
        const all = res.aco_all_offers || [];
        const updated = all.concat(fallback);
        const nextIdx = index + 1;
        const cart = res.aco_cart_items || [];

        chrome.storage.local.set({
          aco_all_offers: updated,
          aco_current_item_index: nextIdx
        }, async () => {
          if (nextIdx < cart.length) {
            await runDelay(800, 200);
            scrapeAlternativesViaIframe(cart[nextIdx], nextIdx, totalItems);
          } else {
            chrome.storage.local.set({ aco_state: "optimizing" }, () => {
              handleStateAction();
            });
          }
        });
      });
    }
  };

  window.addEventListener("message", onMessage);

  // Timeout if iframe never responds (only active if no captcha detected)
  timeoutTimer = setTimeout(() => {
    if (!resolved) {
      // Check if the tab was hidden during this timeout
      if (document.hidden) {
        console.warn(`[ACO] Wykryto nieaktywną kartę podczas timeoutu dla ${item.offer_id}. Wstrzymujemy proces i czekamy na powrót.`);
        window.removeEventListener("message", onMessage);
        iframeNav.destroy();
        
        // Show paused status on the overlay
        overlay.showWorking(
          `Analiza wstrzymana (karta w tle)`,
          Math.round((index / totalItems) * 100),
          `Wstrzymano przy produkcie ${index + 1} z ${totalItems}`,
          `Przełącz się z powrotem na tę kartę, aby wznowić pobieranie dla: ${item.title || item.offer_id}`
        );
        
        // Setup listener to resume when tab is active again
        const onVisible = () => {
          if (!document.hidden) {
            document.removeEventListener("visibilitychange", onVisible);
            console.log(`[ACO] Użytkownik powrócił na kartę. Wznawiamy pobieranie dla ${item.offer_id}...`);
            scrapeAlternativesViaIframe(item, index, totalItems);
          }
        };
        document.addEventListener("visibilitychange", onVisible);
        return;
      }

      resolved = true;
      window.removeEventListener("message", onMessage);
      iframeNav.destroy();
      console.warn(`[ACO] Iframe scrape timeout for ${item.offer_id}`);
      // treat as failed
      const fallback = [{
        product_id_group: item.offer_id,
        base_offer_id: item.offer_id,
        offer_id: item.offer_id,
        seller: item.seller || "Nieznany",
        price: item.price || 9999.0,
        is_smart: item.is_smart || false,
        shipping_cost: item.shipping_cost || DEFAULT_SHIPPING_COST,
        stock: 999,
        required_quantity: item.quantity
      }];

      chrome.storage.local.get(["aco_all_offers", "aco_cart_items"], (res) => {
        const all = res.aco_all_offers || [];
        const updated = all.concat(fallback);
        const nextIdx = index + 1;
        const cart = res.aco_cart_items || [];
        chrome.storage.local.set({ aco_all_offers: updated, aco_current_item_index: nextIdx }, async () => {
          if (nextIdx < cart.length) {
            await runDelay(800, 200);
            scrapeAlternativesViaIframe(cart[nextIdx], nextIdx, totalItems);
          } else {
            chrome.storage.local.set({ aco_state: "optimizing" }, () => handleStateAction());
          }
        });
      });
    }
  }, 25000);
}

function extractInitialTotals() {
  const text = document.body.innerText;
  const cleanPrice = (valStr) => parseFloat(valStr.replace(/\s/g, "").replace(",", ".")) || 0.0;

  const prodMatches = [...text.matchAll(/Wartość\s+produktów\s*([\d\s]+[.,]\d{2})/gi)];
  const totalMatches = [...text.matchAll(/Razem(?:\s+z\s+dostawą)?\s*([\d\s]+[.,]\d{2})/gi)];
  const charityMatches = [...text.matchAll(/Na\s+cele\s+charytatywne\s*([\d\s]+[.,]\d{2})/gi)];

  const charityCost = charityMatches.length > 0 ? cleanPrice(charityMatches[charityMatches.length - 1][1]) : 0.0;

  const totals = {
    products_cost: 0.0,
    shipping_cost: 0.0,
    total_cost: 0.0
  };

  if (prodMatches.length > 0) totals.products_cost = cleanPrice(prodMatches[prodMatches.length - 1][1]);
  if (totalMatches.length > 0) totals.total_cost = cleanPrice(totalMatches[totalMatches.length - 1][1]);

  // Add charity cost to products cost
  totals.products_cost += charityCost;

  // Mathematically calculate shipping cost as total_cost - products_cost
  if (totals.total_cost > 0 && totals.products_cost > 0) {
    totals.shipping_cost = Math.max(0, parseFloat((totals.total_cost - totals.products_cost).toFixed(2)));
  }

  console.log("[ACO] Scraped initial totals:", totals);
  return totals;
}

async function waitForCartTotalChange(oldTotal, timeoutMs = 10000) {
  console.log(`[ACO] Czekam na zmianę całkowitego kosztu (obecnie: ${oldTotal})...`);
  return new Promise(resolve => {
    const start = Date.now();
    const interval = setInterval(() => {
      const currentTotals = extractInitialTotals();
      if (Math.abs(currentTotals.total_cost - oldTotal) > 0.01) {
        clearInterval(interval);
        console.log(`[ACO] Całkowity koszt zmienił się: ${oldTotal} -> ${currentTotals.total_cost}`);
        resolve(true);
      } else if (Date.now() - start > timeoutMs) {
        clearInterval(interval);
        console.warn(`[ACO] Timeout oczekiwania na zmianę całkowitego kosztu koszyka.`);
        resolve(false);
      }
    }, 300);
  });
}

// -------------------------------------------------------------
// STEP 3: RUN THE SOLVER
// -------------------------------------------------------------
async function runOptimization(data) {
  console.log("[ACO] Running Branch-and-Bound optimizer...");

  const allOffers = data.aco_all_offers || [];
  const initialTotals = data.aco_initial_totals || { total_cost: 0 };

  if (allOffers.length === 0) {
    overlay.showError("Brak danych ofert do optymalizacji. Spróbuj ponownie.");
    return;
  }

  // Call the solver in the Background Worker
  console.log("[ACO] Wysyłanie zadania optymalizacji do Background Workera...");
  const result = await sendMessageAsync(
    { action: "optimizeCart", offers: allOffers, initialTotals: initialTotals }
  );

  console.log("[ACO] Optimization results:", result);

  if (!result || !result.assignment || result.assignment.length === 0) {
    if (result && result.error) {
      overlay.showError(`Solver napotkał błąd: ${result.error}`);
    } else {
      overlay.showError("Solver nie był w stanie znaleźć optymalnego koszyka.");
    }
    return;
  }

  // Sprawdzanie czy optymalizacja przyniesie zysk
  const initialList = data.aco_cart_items || [];
  let initialProductCost = 0;
  const initialSellersMap = {};
  initialList.forEach(item => {
    initialProductCost += item.price * item.quantity;
    const s = item.seller || "Nieznany";
    if (!initialSellersMap[s]) {
      initialSellersMap[s] = { shipping_cost: item.shipping_cost || 0.0 };
    } else {
      initialSellersMap[s].shipping_cost = Math.max(initialSellersMap[s].shipping_cost, item.shipping_cost || 0.0);
    }
  });

  const shipmentsBefore = Object.values(initialSellersMap).filter(s => s.shipping_cost > 0).length;

  const sellerStates = result.sellerStates || {};
  const shipmentsAfter = Object.keys(sellerStates).filter(s => {
    const state = sellerStates[s];
    return state.qtyBought > 0 && (state.shippingPaid > 0 || (typeof state.shippingPaid === 'undefined' && state.totalSmartCost < 45.0));
  }).length;

  const isSameTotalCost = Math.abs(result.totalCost - initialTotals.total_cost) <= 0.01;
  let shouldOptimize = false;

  if (result.totalCost < initialTotals.total_cost - 0.01) {
    shouldOptimize = true;
  } else if (isSameTotalCost && shipmentsAfter < shipmentsBefore) {
    shouldOptimize = true;
  }

  if (!shouldOptimize) {
    console.log("[ACO] Brak sensu optymalizacji. Wynik:", { productCost: result.productCost, initialProductCost, shipmentsAfter, shipmentsBefore, totalCost: result.totalCost, initialTotal: initialTotals.total_cost });
    chrome.storage.local.set({ aco_state: "idle" }, () => {
      overlay.showInfo("Koszyk jest optymalny", "Brak lepszych kombinacji", "Aktualna zawartość koszyka to najlepsza możliwa opcja pod kątem produktów i ilości płatnych przesyłek. Optymalizacja nie przyniosłaby oszczędności.");
    });
    return;
  }

  // Oblicz kwotę oszczędności i zapisz jako oczekującą (stats naliczymy dopiero po faktycznym ukończeniu)
  const savedTotal = initialTotals.total_cost - result.totalCost;

  chrome.storage.local.set({
    aco_optimized_list: result.assignment,
    aco_optimized_results: result,
    aco_pending_saved: savedTotal > 0 ? savedTotal : 0,
    aco_current_recreate_index: 0,
    aco_state: "preview"
  }, () => {
    // Go back to the cart to display the preview
    window.location.href = "https://allegro.pl/koszyk";
  });
}

// -------------------------------------------------------------
// STEP 4: CLEAR CURRENT CART
// -------------------------------------------------------------
async function runClearCart() {
  console.log("[ACO] Clearing current cart items...");

  // Try Cookie/Consent banner bypass if present
  try {
    const consentBtn = document.querySelector("button[data-role='accept-consent']");
    if (consentBtn) {
      consentBtn.click();
      await runDelay(1000, 100);
    }
  } catch (e) {
    // ignore
  }

  // Option 1: Bulk delete (dropdown remove)
  try {
    let bulkDropdown = document.querySelector("button[id='delete-offers.dropdown']");
    if (!bulkDropdown) {
      bulkDropdown = [...document.querySelectorAll("button")].find(b => {
        const text = (b.innerText || "").toLowerCase();
        return text === "usuń" || text.includes("usuń");
      });
    }

    if (bulkDropdown) {
      console.log("[ACO] Bulk delete dropdown detected, clicking...");
      bulkDropdown.click();
      await runDelay(1000, 100);

      let deleteAllBtn = document.querySelector("button[data-cy='delete-offers.all']");
      if (!deleteAllBtn) {
        deleteAllBtn = [...document.querySelectorAll("button, li, [role='menuitem']")].find(b => {
          const text = (b.innerText || "").toLowerCase();
          return text.includes("usuń wszystko") || text.includes("usuń wszystkie") || text.includes("usuń zaznaczone");
        });
      }

      if (deleteAllBtn) {
        console.log("[ACO] Delete all option button detected, clicking...");
        deleteAllBtn.click();
        await runDelay(1500, 150);

        // Confirmation Modal Click
        let confirmBtn = document.querySelector("button[data-analytics-interaction-label='removeAllConfirm']");
        if (!confirmBtn) {
          const modal = document.querySelector("div[role='dialog'], [class*='modal'], [class*='dialog']");
          const scope = modal || document;
          confirmBtn = [...scope.querySelectorAll("button")].find(b => {
            const text = (b.innerText || "").toLowerCase();
            return text.includes("tak") || text.includes("potwierdź") || text === "usuń wszystko" || text === "potwierdź";
          });

          if (!confirmBtn && modal) {
            // Fallback to any delete button strictly within the modal
            confirmBtn = [...modal.querySelectorAll("button")].find(b => (b.innerText || "").toLowerCase().includes("usuń"));
          }
        }

        if (confirmBtn) {
          console.log("[ACO] Clicking confirmation button:", confirmBtn.innerText);
          confirmBtn.click();
          await runDelay(4000, 500);
          checkCartIsEmptyAndProceed();
          return;
        } else {
          console.warn("[ACO] Could not find the modal confirmation button.");
        }
      } else {
        console.warn("[ACO] Could not find the delete all option in dropdown.");
      }
    }
  } catch (err) {
    console.warn("[ACO] Bulk clear failed. Falling back to element-by-element removal:", err.message);
  }

  // Option 2 (Fallback): Delete row-by-row
  const deleteBtns = document.querySelectorAll("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot'], button[aria-label*='Usuń z koszyka']");
  if (deleteBtns.length > 0) {
    console.log(`[ACO] Removing item element manually (${deleteBtns.length} items left)...`);
    deleteBtns[0].click();

    // Wait and call runClearCart again to handle AJAX updates or page reloads
    chrome.storage.local.get(["aco_safe_mode"], (res) => {
      const isSafe = res.aco_safe_mode === true;
      const ms = isSafe ? (3000 + Math.random() * 1000) : 300;
      setTimeout(runClearCart, ms);
    });
    return;
  }

  checkCartIsEmptyAndProceed();
}

function checkCartIsEmptyAndProceed() {
  const deleteBtns = document.querySelectorAll("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot']");

  if (deleteBtns.length === 0) {
    console.log("[ACO] Cart is completely empty. Proceeding to next state.");
    chrome.storage.local.get(["aco_optimized_list", "aco_use_share", "aco_next_state_after_clear"], (res) => {
      const optList = res.aco_optimized_list || [];
      const useShare = res.aco_use_share === true;
      const nextState = res.aco_next_state_after_clear || "recreating_cart";
      
      if (nextState === "optimizing" || optList.length > 0) {
        chrome.storage.local.set({
          aco_current_recreate_index: 0,
          aco_state: nextState,
          aco_next_state_after_clear: null
        }, () => {
          handleStateAction();
        });
      } else {
        overlay.showError("Brak pozycji zoptymalizowanych do dodania.");
      }
    });
  } else {
    // Retry clearing after a delay
    setTimeout(runClearCart, 2000);
  }
}

// -------------------------------------------------------------
// STEP 5: ADD OPTIMIZED ITEMS TO CART (SILENT IFRAME)
// -------------------------------------------------------------

async function runSilentCartRebuild(optList, useShare) {
  const rebuildData = await new Promise(resolve => chrome.storage.local.get(["aco_current_recreate_index"], resolve));
  const startIdx = rebuildData.aco_current_recreate_index || 0;

  for (let idx = startIdx; idx < optList.length; idx++) {
    const item = optList[idx];
    const progress = Math.round((idx / optList.length) * 100);
    overlay.showWorking(
      `Aktualizacja koszyka (${idx + 1}/${optList.length})`,
      progress,
      `Dodawanie ${idx + 1} z ${optList.length}`,
      `Oferta ID: ${item.offer_id} (${item.quantity} szt.)`
    );

    try {
      // Oznacz w storage jaki index aktualnie dodajemy, aby content script w iframe wiedział co robić
      await new Promise(resolve => chrome.storage.local.set({ aco_current_recreate_index: idx }, resolve));
      await addItemViaIframe(item, useShare);
      await runDelay(1000, 300);
    } catch (err) {
      console.error(`[ACO] Błąd dodawania ${item.offer_id} przez iframe:`, err);
      
      if (document.hidden) {
        console.warn("[ACO] Karta w tle. Ponawiamy próbę cichego dodawania...");
        idx--; // retry same item
        await runDelay(3000, 1000);
        continue;
      }
      
      console.warn(`[ACO] Nie udało się dodać ${item.offer_id}. Pomiń i skoryguj na końcu.`);
    }
  }

  await new Promise(resolve => chrome.storage.local.set({ aco_current_recreate_index: optList.length }, resolve));
  await verifyAndCorrectCart();
}

function addItemViaIframe(item, useShare) {
  return new Promise((resolve, reject) => {
    const url = buildOfferUrl(item.offer_id, useShare);
    const iframe = iframeNav.createHiddenIframe(url);
    
    let resolved = false;
    let timeoutTimer = null;
    
    const onMessage = (e) => {
      if (!e.data || typeof e.data !== "object") return;
      
      if (e.data.type === "ACO_CAPTCHA_DETECTED") {
        console.warn("[ACO] CAPTCHA detected in iframe!");
        iframeNav.revealAsCaptchaModal();
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = null;
          console.warn("[ACO] Rebuild timeout paused due to CAPTCHA.");
        }
      } else if (e.data.type === "ACO_CAPTCHA_SOLVED") {
        console.log("[ACO] CAPTCHA solved in iframe!");
        iframeNav.hideAgain();
      } else if (e.data.type === "ACO_ITEM_ADDED") {
        console.log("[ACO] Item added successfully via iframe!");
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        window.removeEventListener("message", onMessage);
        iframeNav.destroy();
        resolve();
      } else if (e.data.type === "ACO_ADD_FAILED") {
        console.error("[ACO] Failed to add item in iframe.");
        resolved = true;
        if (timeoutTimer) clearTimeout(timeoutTimer);
        window.removeEventListener("message", onMessage);
        iframeNav.destroy();
        reject(new Error("Add failed internally inside iframe"));
      }
    };
    
    window.addEventListener("message", onMessage);
    
    iframeNav.waitForLoad(20000).then(() => {
      // Give the script inside some time to operate (only set timeout if not already paused/resolved)
      if (!resolved && !timeoutTimer) {
        const timeoutMs = document.hidden ? 60000 : 25000;
        timeoutTimer = setTimeout(() => {
          if (!resolved) {
            window.removeEventListener("message", onMessage);
            iframeNav.destroy();
            reject(new Error("Timeout oczekiwania na dodanie w iframe"));
          }
        }, timeoutMs);
      }
    }).catch(err => {
      if (!resolved) {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        window.removeEventListener("message", onMessage);
        iframeNav.destroy();
        reject(err);
      }
    });
  });
}

// Stara logika używana jako fallback gdy iframe zablokowany
async function runAddToCartFallback(item, index, totalItems, useShare = false) {
  console.log(`[ACO] Recreating Fallback: Adding offer ${item.offer_id} (qty ${item.quantity})...`);

  try {
    const consent = document.querySelector("button[data-role='accept-consent']");
    if (consent) { consent.click(); await runDelay(800, 100); }
  } catch (e) {}

  if (item.quantity > 1) {
    try {
      const qtyInput = document.querySelector("input[type='number']");
      if (qtyInput) {
        setReactInputValue(qtyInput, item.quantity);
        await runDelay(1000, 100);
      }
    } catch (err) {}
  }

  let addBtn = document.querySelector("button[id='add-to-cart-button']") || 
               [...document.querySelectorAll("button")].find(b => {
                 const txt = (b.innerText || "").toLowerCase();
                 return txt.includes("dodaj do koszyka") || txt.includes("dodaj do kosz");
               });

  if (addBtn) {
    console.log("[ACO] Clicking 'Dodaj do koszyka' button.");
    addBtn.click();
    await runDelay(3500, 1000); 

    const nextIdx = index + 1;
    chrome.storage.local.set({ aco_current_recreate_index: nextIdx }, async () => {
      chrome.storage.local.get(["aco_optimized_list", "aco_use_share"], async (res) => {
        const list = res.aco_optimized_list || [];
        const shareFlag = res.aco_use_share === true;
        if (nextIdx < list.length) {
          await runDelay(1500, 200);
          window.location.href = buildOfferUrl(list[nextIdx].offer_id, shareFlag);
        } else {
          chrome.storage.local.set({
            aco_state: "recreating_cart",
            aco_current_recreate_index: list.length
          }, () => {
            window.location.href = "https://allegro.pl/koszyk";
          });
        }
      });
    });
  } else {
    console.error("[ACO] Add to cart button not found!");
    overlay.showError(`Nie znaleziono przycisku 'Dodaj do koszyka' dla oferty: ${item.offer_id}.`);
  }
}

function scrapeCurrentCartDomOnly() {
  const items = {};
  const removeButtons = document.querySelectorAll("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot'], button[aria-label*='Usuń z koszyka']");
  
  removeButtons.forEach(btn => {
    let row = btn.closest("section") || btn.closest("div[data-box-name='cart-item']") || btn.closest("li") || btn.parentElement;
    while (row && row.tagName !== "BODY") {
      if (row.querySelector("a[href*='/oferta/']")) {
        break;
      }
      row = row.parentElement;
    }
    if (!row || row === document.body) return;
    
    const link = row.querySelector("a[href*='/oferta/']");
    if (!link) return;
    
    const href = link.getAttribute("href") || "";
    const match = href.match(/\/oferta\/.*?-?(\d{8,14})/);
    if (!match) return;
    const offerId = match[1];
    
    // Quantity input
    let quantityInput = row.querySelector("input[aria-label='Quantity input field']") || row.querySelector("input[type='number']") || row.querySelector("input[type='text']");
    let quantity = 1;
    if (quantityInput) {
      quantity = parseInt(quantityInput.value) || 1;
    }
    
    items[offerId] = {
      offer_id: offerId,
      quantity: quantity,
      quantityInput: quantityInput,
      removeButton: btn,
      rowElement: row
    };
  });
  
  return items;
}

async function verifyAndCorrectCart() {
  if (!window.location.href.includes("/koszyk")) {
    console.log("[ACO] Przekierowanie do koszyka w celu weryfikacji...");
    window.location.href = "https://allegro.pl/koszyk";
    return;
  }

  overlay.showWorking("Weryfikacja koszyka", 95, "Sprawdzanie spójności...", "Upewniamy się, że koszyk zawiera poprawne produkty i ilości.");

  const data = await new Promise(resolve => chrome.storage.local.get(null, resolve));
  const targetList = data.aco_optimized_list || [];
  const useShare = data.aco_use_share === true;
  const verifyRetries = data.aco_verify_retries || 0;

  // 1. Scrape current cart items from the DOM
  const currentItems = scrapeCurrentCartDomOnly();

  // 2. Compare current items with target items
  const missingItems = [];
  const incorrectQtyItems = [];
  const extraItems = [];

  for (const target of targetList) {
    const current = currentItems[target.offer_id];
    if (!current) {
      missingItems.push(target);
    } else if (current.quantity !== target.quantity) {
      incorrectQtyItems.push({ target, current });
    }
  }

  for (const offerId in currentItems) {
    const isTarget = targetList.some(t => t.offer_id === offerId);
    if (!isTarget) {
      extraItems.push(currentItems[offerId]);
    }
  }

  // If everything matches perfectly, we are done!
  if (missingItems.length === 0 && incorrectQtyItems.length === 0 && extraItems.length === 0) {
    console.log("[ACO] Cart verification passed successfully!");
    chrome.storage.local.set({ aco_verify_retries: 0 }, async () => {
      await finalizeOptimization();
    });
    return;
  }

  console.log("[ACO] Wykryto niezgodności koszyka:", { missingItems, incorrectQtyItems, extraItems, verifyRetries });

  if (verifyRetries >= 5) {
    console.error("[ACO] Osiągnięto limit weryfikacji. Finalizowanie pomimo drobnych rozbieżności.");
    chrome.storage.local.set({ aco_verify_retries: 0 }, async () => {
      await finalizeOptimization();
    });
    return;
  }

  // Increment verify retries
  await new Promise(resolve => chrome.storage.local.set({ aco_verify_retries: verifyRetries + 1 }, resolve));

  // Perform corrections one by one to avoid race conditions
  
  // Correction A: Remove extra items
  if (extraItems.length > 0) {
    const itemToRemove = extraItems[0];
    if (itemToRemove.removeButton) {
      console.log(`[ACO Correction] Usuwanie nadmiarowego produktu: ${itemToRemove.offer_id}`);
      overlay.showWorking("Korekta koszyka", 96, "Usuwanie nadmiarowego produktu...", `ID: ${itemToRemove.offer_id}`);
      itemToRemove.removeButton.click();
      await runDelay(2500, 500);
      window.location.reload();
    } else {
      window.location.reload();
    }
    return;
  }

  // Correction B: Adjust incorrect quantities
  if (incorrectQtyItems.length > 0) {
    const { target, current } = incorrectQtyItems[0];
    
    // Check if we already tried to correct this item
    const failedMap = data.aco_failed_qty_corrections || {};
    
    if (target.quantity > current.quantity && failedMap[target.offer_id] >= 1) {
      // We tried to increase it, but Allegro blocked it. Max stock reached!
      console.warn(`[ACO] Wykryto twardy limit magazynowy dla ${target.offer_id}. Maksymalnie: ${current.quantity} szt.`);
      
      const allOffers = data.aco_all_offers || [];
      const offerIndex = allOffers.findIndex(o => o.offer_id === target.offer_id);
      if (offerIndex !== -1) {
        allOffers[offerIndex].stock = current.quantity;
        
        await new Promise(resolve => chrome.storage.local.set({
          aco_all_offers: allOffers,
          aco_failed_qty_corrections: {},
          aco_verify_retries: 0,
          aco_next_state_after_clear: "optimizing",
          aco_state: "clearing_cart"
        }, resolve));
        
        overlay.showWorking("Wykryto brak towaru", 0, "Obliczanie koszyka na nowo...", `Ograniczenie do ${current.quantity} szt. dla ${target.offer_id}`);
        await runDelay(1500, 500);
        handleStateAction();
        return;
      }
    }
    
    // Register correction attempt
    failedMap[target.offer_id] = (failedMap[target.offer_id] || 0) + 1;
    await new Promise(resolve => chrome.storage.local.set({ aco_failed_qty_corrections: failedMap }, resolve));

    if (current.quantityInput) {
      console.log(`[ACO Correction] Zmiana ilości dla ${target.offer_id}: ${current.quantity} -> ${target.quantity}`);
      overlay.showWorking("Korekta koszyka", 97, "Dostosowywanie ilości...", `ID: ${target.offer_id} (${target.quantity} szt.)`);
      
      const preTotals = extractInitialTotals();
      setReactInputValue(current.quantityInput, target.quantity);
      current.quantityInput.blur();
      
      await waitForCartTotalChange(preTotals.total_cost, 10000);
      await runDelay(500, 200);
      
      window.location.reload();
    } else {
      window.location.reload();
    }
    return;
  }

  // Correction C: Add missing items
  if (missingItems.length > 0) {
    const itemToAdd = missingItems[0];
    console.log(`[ACO Correction] Dodawanie brakującego produktu: ${itemToAdd.offer_id}`);
    overlay.showWorking("Korekta koszyka", 98, "Dodawanie brakującego produktu...", `ID: ${itemToAdd.offer_id}`);
    
    try {
      await new Promise(resolve => chrome.storage.local.set({ aco_correction_item: itemToAdd }, resolve));
      await addItemViaIframe(itemToAdd, useShare);
      await runDelay(1500, 300);
    } catch (err) {
      console.error("[ACO Correction] Błąd podczas dodawania brakującego produktu:", err);
    } finally {
      await new Promise(resolve => chrome.storage.local.remove(["aco_correction_item"], resolve));
    }
    
    window.location.reload();
    return;
  }
}

async function finalizeOptimization() {
  await runDelay(1200, 200);
  chrome.storage.local.get(["aco_stats", "aco_initial_totals"], (res) => {
    const stats = res.aco_stats || {
      total_optimizations: 0,
      total_saved: 0.0,
      average_saved: 0.0,
      max_single_saved: 0.0
    };
    const initialTotals = res.aco_initial_totals;

    // Scrape final totals from the DOM
    const finalTotals = extractInitialTotals();
    
    // Oblicz faktyczne oszczędności na podstawie rzeczywistych cen z koszyka
    let savedTotal = 0;
    if (initialTotals && finalTotals) {
      savedTotal = initialTotals.total_cost - finalTotals.total_cost;
    }

    if (savedTotal > 0.01) {
      stats.total_optimizations += 1;
      stats.total_saved += savedTotal;
      stats.average_saved = stats.total_saved / stats.total_optimizations;
      stats.max_single_saved = Math.max(stats.max_single_saved, savedTotal);
      console.log(`[ACO] Statystyki zaktualizowane po ukończeniu: zaoszczędzono ${savedTotal.toFixed(2)} zł`);
    } else {
      console.log(`[ACO] Brak faktycznych oszczędności na końcu procesu. Pomięcie aktualizacji statystyk. Zmiana: ${savedTotal.toFixed(2)} zł`);
    }

    chrome.storage.local.set({
      aco_stats: stats,
      aco_pending_saved: 0,
      aco_state: "completed",
      aco_final_totals: finalTotals
    }, () => {
      // W trybie cichej nawigacji musimy przeładować koszyk aby zobaczyć nowe produkty, 
      // lub nawigować do koszyka jeśli jesteśmy w fallback mode (na innej podstronie).
      window.location.href = "https://allegro.pl/koszyk";
    });
  });
}

// -------------------------------------------------------------
// EVENT LISTENERS AND BOOTSTRAP
// -------------------------------------------------------------

if (window.top !== window.self) {
  console.log("[ACO] Inicjalizacja skryptu wewnątrz iframe...");
  checkIframeTasks();
} else {



  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.action === "startOptimization") {
      console.log("[ACO] startOptimization message received!");
      sendResponse({ status: "started" });
      chrome.storage.local.set({ aco_state: "scraping_cart" }, () => {
        handleStateAction();
      });
    } else if (msg.action === "resetState") {
      console.log("[ACO] resetState message received!");
      sendResponse({ status: "reset" });
      overlay.destroy();
    }
  });

  // Run automatically on page load
  handleStateAction();
}

// Wait for product ID to be extracted from DOM scripts (polling to prevent hydration race conditions)
function waitForProductId(offerId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      let productId = null;

      // 1. Check data-serialize-box-id scripts
      document.querySelectorAll("script[data-serialize-box-id]").forEach(s => {
        try {
          const data = JSON.parse(s.textContent);
          if (data && data.otherProductOffers && data.otherProductOffers.productId) {
            productId = data.otherProductOffers.productId;
          }
        } catch (e) {}
      });

      // 2. Check canonical link
      if (!productId) {
        const canonical = document.querySelector("link[rel='canonical']");
        if (canonical && canonical.href) {
          const match = canonical.href.match(/-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
          if (match) productId = match[1];
        }
      }

      if (productId) {
        clearInterval(interval);
        resolve(productId);
      } else if (Date.now() - startTime > timeoutMs) {
        clearInterval(interval);
        resolve(null);
      }
    }, 200);
  });
}

// Centralized helper to detect CAPTCHA or Cloudflare security challenges
function isCaptchaOrChallengePage() {
  const title = (document.title || "").toLowerCase();
  const url = window.location.href;
  
  if (url.includes("captcha") || url.includes("challenge")) {
    return true;
  }
  if (title.includes("captcha") || title.includes("just a moment") || title.includes("attention required") || title.includes("cloudflare")) {
    return true;
  }
  if (document.querySelector(".cf-challenge, #challenge-form, [data-captcha], #cf-wrapper, #turnstile-wrapper")) {
    return true;
  }
  return false;
}

async function checkIframeTasks() {
  const url = window.location.href;

  // CAPTCHA / challenge detection
  if (isCaptchaOrChallengePage()) {
    window.parent.postMessage({ type: "ACO_CAPTCHA_DETECTED" }, "*");
    return;
  }

  if (!url.includes("/oferta/") && !url.includes("/oferty-produktu/")) return;

  chrome.storage.local.get(["aco_state", "aco_cart_items", "aco_current_item_index",
                              "aco_optimized_list", "aco_current_recreate_index"], async (res) => {

    // ---- MODE 1: SCRAPING ALTERNATIVES ----
    if (res.aco_state === "scraping_alternatives") {
      const cart = res.aco_cart_items || [];
      const idx = res.aco_current_item_index || 0;
      const item = cart[idx];

      if (!item) {
        window.parent.postMessage({ type: "ACO_SCRAPE_FAILED" }, "*");
        return;
      }

      // Case A: We are on the offer page - extract Product ID and redirect to the comparison page
      if (url.includes("/oferta/")) {
        console.log(`[ACO iframe] Loaded offer page for ${item.offer_id}. Extracting product ID...`);
        
        if (isCaptchaOrChallengePage()) {
          window.parent.postMessage({ type: "ACO_CAPTCHA_DETECTED" }, "*");
          return;
        }

        const productId = await waitForProductId(item.offer_id, 4000);

        if (isCaptchaOrChallengePage()) {
          window.parent.postMessage({ type: "ACO_CAPTCHA_DETECTED" }, "*");
          return;
        }

        if (productId) {
          const compareUrl = `https://allegro.pl/oferty-produktu/produkt-${productId}?order=p&buyNew=1&offerTypeBuyNow=1`;
          console.log(`[ACO iframe] Redirecting iframe to comparison page: ${compareUrl}`);
          window.location.replace(compareUrl);
          return;
        } else {
          console.warn(`[ACO iframe] No product ID found for ${item.offer_id}. Returning original offer.`);
          const fallback = [{
            product_id_group: item.offer_id,
            base_offer_id: item.offer_id,
            offer_id: item.offer_id,
            seller: item.seller || "Nieznany",
            price: item.price || 9999.0,
            is_smart: item.is_smart || false,
            shipping_cost: item.shipping_cost || DEFAULT_SHIPPING_COST,
            stock: 999,
            required_quantity: item.quantity
          }];
          window.parent.postMessage({ type: "ACO_ALTERNATIVES_SCRAPED", offers: fallback }, "*");
          return;
        }
      }

      // Case B: We are on the comparison page - perform scrolling and scrape alternative offers
      if (url.includes("/oferty-produktu/")) {
        console.log("[ACO iframe] Loaded comparison page. Starting lazy scroll...");
        
        await runDelay(1000, 200);

        // Try to accept GDPR consent modal if present
        try {
          const consent = document.querySelector("button[data-role='accept-consent']");
          if (consent) {
            console.log("[ACO iframe] Found consent button on comparison page. Clicking it...");
            consent.click();
            await runDelay(1200, 200);
          }
        } catch (e) {}

        // Scroll down dynamically to load all lazy content
        const scrollTimer = setInterval(() => {
          try {
            const height = Math.max(
              document.body.scrollHeight,
              document.documentElement.scrollHeight,
              3000
            );
            window.scrollTo(0, height);
          } catch (e) {}
        }, 400);

        await runDelay(3000, 500);
        clearInterval(scrollTimer);
        console.log("[ACO iframe] Scroll sequence finished. Parsing offers...");

        // Check for CAPTCHA
        if (isCaptchaOrChallengePage()) {
          window.parent.postMessage({ type: "ACO_CAPTCHA_DETECTED" }, "*");
          return;
        }

        let productIdGroup = item.offer_id;
        const canonical = document.querySelector("link[rel='canonical']");
        if (canonical && canonical.href) {
          const match = canonical.href.match(/-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
          if (match) productIdGroup = match[1];
        }

        let offersList = [];

        // Method 1: SSR/hydration JSON in <script data-serialize-box-id>
        const scripts = document.querySelectorAll("script[data-serialize-box-id]");
        scripts.forEach(s => {
          try {
            const data = JSON.parse(s.textContent);
            if (data && data.__listing_StoreState) {
              const elements = data.__listing_StoreState.items?.elements || [];
              elements.forEach(el => {
                const offerIdVal = el.id;
                if (!offerIdVal || !/^\d+$/.test(String(offerIdVal))) return;

                const sellerName = normalizeSeller(el.seller?.login || "Nieznany");
                let priceVal = 9999.0;
                if (el.price?.mainPrice?.amount) priceVal = parseFloat(el.price.mainPrice.amount);

                let smart = false;
                const labels = el.freebox?.labels || [];
                labels.forEach(lbl => {
                  (lbl.labelParts || []).forEach(p => {
                    if (p.text && p.text.toLowerCase().includes("smart")) smart = true;
                  });
                });
                if (!smart) {
                  const str = JSON.stringify(el);
                  if (str.includes('"Smart!"') || str.includes('is_smart":true')) smart = true;
                }

                let shippingCost = DEFAULT_SHIPPING_COST;
                if (el.shipping?.lowest?.amount) shippingCost = parseFloat(el.shipping.lowest.amount);

                offersList.push({
                  product_id_group: productIdGroup,
                  base_offer_id: item.offer_id,
                  offer_id: String(offerIdVal),
                  seller: sellerName,
                  price: priceVal,
                  is_smart: smart,
                  shipping_cost: shippingCost,
                  stock: el.quantity || 999,
                  required_quantity: item.quantity
                });
              });
            }
          } catch (e) {}
        });

        // Method 2: DOM fallback
        if (offersList.length === 0) {
          const liItems = document.querySelectorAll(".opbox-listing li, li[data-role='offer-card'], [data-box-name='listing'] li");
          liItems.forEach(li => {
            try {
              const aTag = li.querySelector("a[href*='/oferta/']");
              if (!aTag) return;
              const href = aTag.getAttribute("href") || "";
              const match = href.match(/\/oferta\/.*?-?(\d{8,14})/);
              if (!match) return;
              const offerIdVal = match[1];

              const sellerTag = li.querySelector("a[href*='/uzytkownik/'], a[href*='/sklep/']");
              const sellerName = sellerTag ? normalizeSeller(sellerTag.getAttribute("href") || sellerTag.innerText) : "nieznany";

              let priceVal = 9999.0;
              const text = li.innerText || "";
              const priceMatch = text.match(/([\d\s]+[.,]\d{2})\s*zł/);
              if (priceMatch) priceVal = parseFloat(priceMatch[1].replace(/\s/g, "").replace(",", ".")) || 9999.0;

              const isSmart = !!li.querySelector("button[aria-label*='Smart!'], [aria-label*='Smart'], img[src*='smart']") || text.toLowerCase().includes("smart");

              let shippingCost = DEFAULT_SHIPPING_COST;
              const shipMatch = text.match(/dostawa\s+od\s+([\d\s]+[.,]\d{2})\s*zł/i) || text.match(/dostawa\s+([\d\s]+[.,]\d{2})\s*zł/i);
              if (shipMatch) shippingCost = parseFloat(shipMatch[1].replace(/\s/g, "").replace(",", ".")) || DEFAULT_SHIPPING_COST;

              let stock = 999;
              const tl = text.toLowerCase();
              if (tl.includes("ostatnia sztuka")) stock = 1;
              else if (tl.includes("ostatnie 2 sztuki")) stock = 2;

              offersList.push({ product_id_group: productIdGroup, base_offer_id: item.offer_id, offer_id: offerIdVal, seller: sellerName, price: priceVal, is_smart: isSmart, shipping_cost: shippingCost, stock, required_quantity: item.quantity });
            } catch (err) {}
          });
        }

        // Always include the original offer
        if (!offersList.some(o => o.offer_id === item.offer_id)) {
          offersList.push({
            product_id_group: productIdGroup,
            base_offer_id: item.offer_id,
            offer_id: item.offer_id,
            seller: item.seller || "Nieznany",
            price: item.price || 9999.0,
            is_smart: item.is_smart || false,
            shipping_cost: item.shipping_cost || DEFAULT_SHIPPING_COST,
            stock: 999,
            required_quantity: item.quantity
          });
        }

        console.log(`[ACO iframe] Scraped ${offersList.length} alternatives for ${item.offer_id}`);
        
        if (offersList.length <= 1) {
          chrome.storage.local.get(["aco_current_item_retry"], (resVal) => {
            const retries = resVal.aco_current_item_retry || 0;
            if (retries < 2) {
              console.log(`[ACO iframe] Scraped 0 alternatives on comparison page. Retrying reload (${retries + 1}/2)...`);
              chrome.storage.local.set({ aco_current_item_retry: retries + 1 }, () => {
                window.location.reload();
              });
            } else {
              console.log("[ACO iframe] Max retries reached on comparison page. Returning fallback.");
              chrome.storage.local.set({ aco_current_item_retry: 0 }, () => {
                window.parent.postMessage({ type: "ACO_ALTERNATIVES_SCRAPED", offers: offersList }, "*");
              });
            }
          });
        } else {
          chrome.storage.local.set({ aco_current_item_retry: 0 }, () => {
            window.parent.postMessage({ type: "ACO_ALTERNATIVES_SCRAPED", offers: offersList }, "*");
          });
        }
        return;
      }
    }

    // ---- MODE 2: RECREATING CART ----
    if (res.aco_state === "recreating_cart") {
      let item = res.aco_correction_item;
      if (!item) {
        const list = res.aco_optimized_list || [];
        const idx = res.aco_current_recreate_index || 0;
        item = list[idx];
      }

      if (!item || !url.includes(item.offer_id)) {
        window.parent.postMessage({ type: "ACO_ADD_FAILED" }, "*");
        return;
      }

      await runDelay(1000, 200);

      try {
        const consent = document.querySelector("button[data-role='accept-consent']");
        if (consent) { consent.click(); await runDelay(500, 100); }
      } catch (e) {}

      if (item.quantity > 1) {
        try {
          const qtyInput = document.querySelector("input[type='number']");
          if (qtyInput) {
            setReactInputValue(qtyInput, item.quantity);
            await runDelay(1000, 100);
          }
        } catch (err) {}
      }

      const addBtn = document.querySelector("button[id='add-to-cart-button']") ||
                     [...document.querySelectorAll("button")].find(b => {
                       const txt = (b.innerText || "").toLowerCase();
                       return txt.includes("dodaj do koszyka") || txt.includes("dodaj do kosz");
                     });

      if (addBtn) {
        addBtn.click();
        await runDelay(3000, 500);
        window.parent.postMessage({ type: "ACO_ITEM_ADDED" }, "*");
      } else {
        window.parent.postMessage({ type: "ACO_ADD_FAILED" }, "*");
      }
    }
  });
}
