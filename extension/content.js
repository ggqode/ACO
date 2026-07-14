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
    const isSafeMode = res.aco_safe_mode !== false;
    if (isSafeMode) {
      simulateHumanScroll();
    }
  });
}

// Wrapper for delay based on Safe Mode setting
function runDelay(safeMs, fastMs = 200) {
  return new Promise((resolve) => {
    chrome.storage.local.get(["aco_safe_mode"], async (res) => {
      const isSafeMode = res.aco_safe_mode !== false;
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
          ⚠️ <strong>Nie zamykaj tej karty.</strong> ACO będzie automatycznie przechodzić pomiędzy stronami Allegro i po zakończeniu wróci do koszyka.
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

  showSummary(results, initial, optimizedList, stats, initialList = [], isPreview = false) {
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

    const savedAmount = Math.max(0, totalCostBefore - totalCostAfter);

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
              <th>Po</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>Produkty</td>
              <td>${fmt(prodCostBefore)} zł</td>
              <td>${fmt(prodCostAfter)} zł</td>
            </tr>
            <tr>
              <td>Dostawa</td>
              <td>${fmt(shipCostBefore)} zł</td>
              <td>${fmt(shipCostAfter)} zł</td>
            </tr>
            <tr>
              <td>Suma razem</td>
              <td><strong>${fmt(totalCostBefore)} zł</strong></td>
              <td><strong>${fmt(totalCostAfter)} zł</strong></td>
            </tr>
            <tr>
              <td>Sprzedawcy</td>
              <td>${sellersBefore}</td>
              <td>${sellersAfter}</td>
            </tr>
            <tr>
              <td>Płatne przesyłki</td>
              <td>${shipmentsBefore}</td>
              <td>${shipmentsAfter}</td>
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
  else if (state === "scraping_alternatives") {
    const idx = data.aco_current_item_index || 0;
    const items = data.aco_cart_items || [];

    if (idx < items.length) {
      const item = items[idx];
      const progress = Math.round((idx / items.length) * 100);
      overlay.showWorking(
        `Analiza ofert (${idx + 1}/${items.length})`,
        progress,
        `Przedmiot ${idx + 1} z ${items.length}`,
        item.title || item.offer_id
      );

      // Confirm we are on the alternatives page of this offer
      const currentUrl = window.location.href;
      if (currentUrl.includes(item.offer_id)) {
        runScroll();
        await runDelay(1200, 200); // human sleep
        await runScrapeAlternatives(item, idx, items.length);
      } else {
        // If we reloaded and got misdirected, navigate to the correct alternatives URL
        console.warn("[ACO] Displaced from alternatives page. Navigating back...");
        window.location.href = `https://allegro.pl/oferta/${item.offer_id}?order=p&buyNew=1&offerTypeBuyNow=1&p=1#inne-oferty-produktu`;
      }
    } else {
      // All alternatives scraped, proceed to solve
      chrome.storage.local.set({ aco_state: "optimizing" }, () => {
        handleStateAction();
      });
    }
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
  else if (state === "recreating_cart") {
    const idx = data.aco_current_recreate_index || 0;
    const optList = data.aco_optimized_list || [];
    const useShare = data.aco_use_share === true;

    if (idx < optList.length) {
      const item = optList[idx];
      const progress = Math.round((idx / optList.length) * 100);
      overlay.showWorking(
        `Aktualizacja koszyka (${idx + 1}/${optList.length})`,
        progress,
        `Dodawanie ${idx + 1} z ${optList.length}`,
        `Oferta ID: ${item.offer_id} (${item.quantity} szt.)`
      );

      const currentUrl = window.location.href;
      if (currentUrl.includes(item.offer_id)) {
        runScroll();
        await runDelay(1200, 200);
        await runAddToCart(item, idx, optList.length, useShare);
      } else {
        console.warn("[ACO] Displaced from offer page. Navigating back...");
        window.location.href = buildOfferUrl(item.offer_id, useShare);
      }
    } else {
      // Complete! Go back to cart page
      chrome.storage.local.set({ aco_state: "completed" }, () => {
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
    const optList = data.aco_optimized_list || [];
    const stats = data.aco_stats || {
      total_optimizations: 0,
      total_saved: 0.0,
      average_saved: 0.0,
      max_single_saved: 0.0
    };

    if (results && initial) {
      overlay.showSummary(results, initial, optList, stats, data.aco_cart_items || []);
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
    // Wait for at least one offer link to ensure cart page is loaded
    await waitForSelector("a[href*='/oferta/']", 15000);
  } catch (err) {
    console.error("[ACO] No offers found in DOM:", err.message);
    overlay.showError("Nie znaleziono przedmiotów w koszyku. Dodaj produkty przed optymalizacją.");
    return;
  }

  // Scrape initial totals
  const initialTotals = extractInitialTotals();

  // Scrape cart offers
  const cartOffers = {};
  const links = document.querySelectorAll("a[href*='/oferta/']");

  links.forEach(link => {
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

      // Ascend DOM to locate row container
      let row = link.closest("section") || link.closest("div[data-box-name='cart-item']") || link.closest("li") || link.parentElement;
      while (row && row.tagName !== "BODY") {
        if (row.querySelector("input[type='number']") || row.querySelector("button[data-cy='offer-row.remove']")) {
          break;
        }
        row = row.parentElement;
      }

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

  // Save items and transition state
  chrome.storage.local.set({
    aco_cart_items: cartList,
    aco_initial_totals: initialTotals,
    aco_all_offers: [],
    aco_current_item_index: 0,
    aco_state: "scraping_alternatives"
  }, async () => {
    // Wait a random delay before navigating to prevent instant request bursts
    await runDelay(1200, 200);
    const first = cartList[0];
    window.location.href = `https://allegro.pl/oferta/${first.offer_id}?order=p&buyNew=1&offerTypeBuyNow=1&p=1#inne-oferty-produktu`;
  });
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

// -------------------------------------------------------------
// STEP 2: SCRAPE ALTERNATIVE OFFERS PER PRODUCT
// -------------------------------------------------------------
async function runScrapeAlternatives(item, index, totalItems) {
  console.log(`[ACO] Scraping alternatives for ${item.offer_id}...`);

  // Wait up to 30s for the actual alternative offer links to load and render
  let loaded = false;
  for (let t = 0; t < 60; t++) {
    const offerLink = document.querySelector(".opbox-listing a, li[data-role='offer-card'] a");
    if (offerLink) {
      loaded = true;
      break;
    }
    await new Promise(r => setTimeout(r, 500));
  }

  if (!loaded) {
    console.warn("[ACO] Alternatives listing links load timed out (30s). Trying page reload...");
    window.location.reload();
    // Czekamy kolejne 30 sekund po reloadzie
    for (let t = 0; t < 60 && !loaded; t++) {
      const offerLink = document.querySelector(".opbox-listing a, li[data-role='offer-card'] a");
      if (offerLink) {
        loaded = true;
        break;
      }
      await new Promise(r => setTimeout(r, 500));
    }
    if (!loaded) {
      console.warn("[ACO] Alternatives listing still not loaded after reload. Proceeding with fallback.");
    }
    await new Promise(r => setTimeout(r, 500));
  } else {
    // Brief settle delay to allow React state scripts to hydrate completely
    await new Promise(r => setTimeout(r, 500));
  }

  // Determine the canonical product group id if available
  let productIdGroup = item.offer_id;
  const canonical = document.querySelector("link[rel='canonical']");
  if (canonical && canonical.href) {
    const match = canonical.href.match(/-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})/);
    if (match) {
      productIdGroup = match[1];
    }
  }

  let container = document.querySelector(".opbox-listing, #inne-oferty-produktu, [data-box-name='listing']");
  if (!container) {
    container = document.querySelector("div[class*='listing']");
  }

  let offersList = [];

  // Method 1: Extract from serialized JS scripts (Query globally to ensure we find Next.js/React state blocks)
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
          if (el.price?.mainPrice?.amount) {
            priceVal = parseFloat(el.price.mainPrice.amount);
          }

          let smart = false;
          const labels = el.freebox?.labels || [];
          labels.forEach(lbl => {
            const parts = lbl.labelParts || [];
            parts.forEach(p => {
              if (p.text && (p.text.includes("Smart!") || p.text.toLowerCase().includes("smart"))) {
                smart = true;
              }
            });
          });

          if (!smart) {
            // Dodatkowe sprawdzenie w serializowanym JSON
            const str = JSON.stringify(el);
            if (str.includes('"Smart!"') || str.includes('"smart!"') || str.includes('is_smart":true')) {
              smart = true;
            }
          }

          let shippingCost = DEFAULT_SHIPPING_COST;
          if (el.shipping?.lowest?.amount) {
            shippingCost = parseFloat(el.shipping.lowest.amount);
          }

          const stock = el.quantity || 999;

          offersList.push({
            product_id_group: productIdGroup,
            base_offer_id: item.offer_id,
            offer_id: String(offerIdVal),
            seller: sellerName,
            price: priceVal,
            is_smart: smart,
            shipping_cost: shippingCost,
            stock: stock,
            required_quantity: item.quantity
          });
        });
      }
    } catch (e) {
      // ignore JSON parse errors
    }
  });

  // Method 2: Fallback to scraping the DOM HTML
  if (offersList.length === 0) {
    console.log("[ACO] Script parse returned 0 offers. Checking DOM HTML...");
    const liItems = container
      ? container.querySelectorAll("li, li[data-role='offer-card']")
      : document.querySelectorAll(".opbox-listing li, li[data-role='offer-card']");
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
        if (priceMatch) {
          priceVal = parseFloat(priceMatch[1].replace(/\s/g, "").replace(",", ".")) || 9999.0;
        }

        const isSmart = !!li.querySelector("button[aria-label*='Smart!'], [aria-label*='Smart'], img[src*='smart']") || text.toLowerCase().includes("smart");

        let shippingCost = DEFAULT_SHIPPING_COST;
        const shipMatch = text.match(/dostawa\s+od\s+([\d\s]+[.,]\d{2})\s*zł/i) || text.match(/dostawa\s+([\d\s]+[.,]\d{2})\s*zł/i);
        if (shipMatch) {
          shippingCost = parseFloat(shipMatch[1].replace(/\s/g, "").replace(",", ".")) || DEFAULT_SHIPPING_COST;
        }

        // Available stock estimation
        let stock = 999;
        const textLower = text.toLowerCase();
        if (textLower.includes("ostatnia sztuka")) stock = 1;
        else if (textLower.includes("ostatnie 2 sztuki")) stock = 2;

        offersList.push({
          product_id_group: productIdGroup,
          base_offer_id: item.offer_id,
          offer_id: offerIdVal,
          seller: sellerName,
          price: priceVal,
          is_smart: isSmart,
          shipping_cost: shippingCost,
          stock: stock,
          required_quantity: item.quantity
        });
      } catch (err) {
        // ignore
      }
    });
  }

  // Method 3: Always include the original cart offer as a candidate so the solver can always fallback to it!
  const originalAlreadyIncluded = offersList.some(o => o.offer_id === item.offer_id);
  if (!originalAlreadyIncluded) {
    console.log("[ACO] Prepending original cart item to candidates pool.");
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

  console.log(`[ACO] Found ${offersList.length} offers for item index ${index}`);

  // Fetch all compiled offers from storage, append, and save
  chrome.storage.local.get(["aco_all_offers", "aco_cart_items"], (res) => {
    const all = res.aco_all_offers || [];
    const updated = all.concat(offersList);
    const nextIdx = index + 1;
    const cart = res.aco_cart_items || [];

    chrome.storage.local.set({
      aco_all_offers: updated,
      aco_current_item_index: nextIdx
    }, async () => {
      if (nextIdx < cart.length) {
        // Wait a random delay to avoid bot detection rate limits
        await runDelay(1500, 200);
        const nextItem = cart[nextIdx];
        window.location.href = `https://allegro.pl/oferta/${nextItem.offer_id}?order=p&buyNew=1&offerTypeBuyNow=1&p=1#inne-oferty-produktu`;
      } else {
        chrome.storage.local.set({ aco_state: "optimizing" }, () => {
          handleStateAction();
        });
      }
    });
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
      const isSafe = res.aco_safe_mode !== false;
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
    console.log("[ACO] Cart is completely empty. Starting recreation.");
    chrome.storage.local.get(["aco_optimized_list", "aco_use_share"], (res) => {
      const optList = res.aco_optimized_list || [];
      const useShare = res.aco_use_share === true;
      if (optList.length > 0) {
        chrome.storage.local.set({
          aco_current_recreate_index: 0,
          aco_state: "recreating_cart"
        }, () => {
          window.location.href = buildOfferUrl(optList[0].offer_id, useShare);
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
// STEP 5: ADD OPTIMIZED ITEMS TO CART
// -------------------------------------------------------------
async function runAddToCart(item, index, totalItems, useShare = false) {
  console.log(`[ACO] Recreating: Adding offer ${item.offer_id} (qty ${item.quantity})...`);

  // Bypass cookie consent if needed
  try {
    const consent = document.querySelector("button[data-role='accept-consent']");
    if (consent) {
      consent.click();
      await runDelay(800, 100);
    }
  } catch (e) {
    // ignore
  }

  // Set quantity if greater than 1
  if (item.quantity > 1) {
    try {
      const qtyInput = document.querySelector("input[type='number']");
      if (qtyInput) {
        qtyInput.value = item.quantity;
        qtyInput.dispatchEvent(new Event("change", { bubbles: true }));
        qtyInput.dispatchEvent(new Event("input", { bubbles: true }));
        await runDelay(1000, 100);
      }
    } catch (err) {
      console.warn("[ACO] Could not fill quantity input:", err.message);
    }
  }

  // Click add-to-cart button
  let addBtn = null;
  const possibleSelectors = [
    "button[id='add-to-cart-button']",
    "button:has-text('dodaj do koszyka')",
    "button:has-text('Dodaj do koszyka')"
  ];

  for (const sel of possibleSelectors) {
    if (sel.includes("has-text")) {
      const text = sel.match(/'(.*)'/)[1];
      addBtn = [...document.querySelectorAll("button")].find(b => b.innerText && b.innerText.includes(text));
    } else {
      addBtn = document.querySelector(sel);
    }
    if (addBtn) break;
  }

  // Direct element check fallback
  if (!addBtn) {
    addBtn = [...document.querySelectorAll("button")].find(b => {
      const txt = (b.innerText || "").toLowerCase();
      return txt.includes("dodaj do koszyka") || txt.includes("dodaj do kosz");
    });
  }

  if (addBtn) {
    console.log("[ACO] Clicking 'Dodaj do koszyka' button.");
    addBtn.click();
    await runDelay(3500, 1000); // Wait for modal/toast confirmations

    // Transition to next index
    const nextIdx = index + 1;
    chrome.storage.local.set({
      aco_current_recreate_index: nextIdx
    }, async () => {
      chrome.storage.local.get(["aco_optimized_list", "aco_use_share"], async (res) => {
        const list = res.aco_optimized_list || [];
        const shareFlag = res.aco_use_share === true;
        if (nextIdx < list.length) {
          // Wait a random delay to look human-like
          await runDelay(1500, 200);
          window.location.href = buildOfferUrl(list[nextIdx].offer_id, shareFlag);
        } else {
          // Koszyk przebudowany w całości – teraz nalicz statystyki
          await runDelay(1200, 200);
          chrome.storage.local.get(["aco_stats", "aco_pending_saved"], (statsRes) => {
            const stats = statsRes.aco_stats || {
              total_optimizations: 0,
              total_saved: 0.0,
              average_saved: 0.0,
              max_single_saved: 0.0
            };
            const pendingSaved = statsRes.aco_pending_saved || 0;

            if (pendingSaved > 0) {
              stats.total_optimizations += 1;
              stats.total_saved += pendingSaved;
              stats.average_saved = stats.total_saved / stats.total_optimizations;
              stats.max_single_saved = Math.max(stats.max_single_saved, pendingSaved);
              console.log(`[ACO] Statystyki zaktualizowane po ukończeniu: zaoszczędzono ${pendingSaved.toFixed(2)} zł`);
            }

            chrome.storage.local.set({
              aco_stats: stats,
              aco_pending_saved: 0,
              aco_state: "completed"
            }, () => {
              window.location.href = "https://allegro.pl/koszyk";
            });
          });
        }
      });
    });
  } else {
    console.error("[ACO] Add to cart button not found!");
    overlay.showError(`Nie znaleziono przycisku 'Dodaj do koszyka' dla oferty: ${item.offer_id}. Prawdopodobnie wygasła lub zmienił się interfejs.`);
  }
}

// -------------------------------------------------------------
// EVENT LISTENERS AND BOOTSTRAP
// -------------------------------------------------------------

// Listen to message from Popup to trigger cart scraping
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
