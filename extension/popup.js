/**
 * ACO - Cart Optimizer - Popup Script
 */

document.addEventListener("DOMContentLoaded", () => {
  const statusPulse = document.getElementById("status-pulse");
  const statusText = document.getElementById("status-text");
  const optimizeBtn = document.getElementById("optimize-btn");
  const resetBtn = document.getElementById("reset-btn");
  const safeModeToggle = document.getElementById("safe-mode-toggle");
  const resetStatsBtn = document.getElementById("reset-stats-btn");

  const statCount = document.getElementById("stat-count");
  const statTotal = document.getElementById("stat-total");
  const statAvg = document.getElementById("stat-avg");
  const statMax = document.getElementById("stat-max");

  let activeTabId = null;
  let isOnCartPage = false; // tracks whether current tab is the cart page

  // Load safe mode setting
  chrome.storage.local.get(["aco_safe_mode"], (res) => {
    const safeMode = res.aco_safe_mode === true; // default to false
    safeModeToggle.checked = safeMode;
  });

  // Handle safe mode toggle
  safeModeToggle.addEventListener("change", () => {
    chrome.storage.local.set({ aco_safe_mode: safeModeToggle.checked });
  });

  // 1. Load statistics from local storage
  function loadStatistics() {
    chrome.storage.local.get(["aco_stats"], (res) => {
      const stats = res.aco_stats || {
        total_optimizations: 0,
        total_saved: 0.0,
        average_saved: 0.0,
        max_single_saved: 0.0
      };

      statCount.textContent = stats.total_optimizations;
      statTotal.textContent = `${stats.total_saved.toFixed(2)} zł`;
      statAvg.textContent = `${stats.average_saved.toFixed(2)} zł`;
      statMax.textContent = `${stats.max_single_saved.toFixed(2)} zł`;
    });
  }

  // 2. Check tab status and extension state
  function updatePopupUI() {
    chrome.storage.local.get(["aco_state"], (storageRes) => {
      const state = storageRes.aco_state || "idle";

      // If optimization is currently running
      if (state !== "idle" && state !== "completed" && state !== "error") {
        statusPulse.className = "status-pulse working";
        statusText.textContent = "Optymalizowanie koszyka...";
        optimizeBtn.disabled = true;
        optimizeBtn.textContent = "Optymalizacja w toku...";
        resetBtn.style.display = "block";
        safeModeToggle.disabled = true;
        return;
      }

      resetBtn.style.display = "none";
      safeModeToggle.disabled = false;

      // If idle/completed, check if we are on the correct page
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (!tabs || !tabs[0]) {
          showNotOnCartPage();
          return;
        }

        const activeTab = tabs[0];
        activeTabId = activeTab.id;
        const url = activeTab.url || "";

        // Matches https://allegro.pl/koszyk or subdomains
        const isCartPage = url.includes("allegro.pl/koszyk");

        if (isCartPage) {
          isOnCartPage = true;
          statusPulse.className = "status-pulse ready";
          statusText.textContent = "Koszyk gotowy do optymalizacji";
          optimizeBtn.disabled = false;
          optimizeBtn.textContent = "Optymalizuj koszyk";
        } else {
          isOnCartPage = false;
          showNotOnCartPage();
        }
      });
    });
  }

  function showNotOnCartPage() {
    statusPulse.className = "status-pulse";
    statusText.textContent = "Nie jesteś na stronie koszyka";
    optimizeBtn.disabled = false;
    optimizeBtn.textContent = "Przejdź do koszyka →";
    optimizeBtn.style.background = "linear-gradient(135deg, #2a2a2a, #333)";
    optimizeBtn.style.boxShadow = "none";
  }

  // 3. Start optimization button handler
  optimizeBtn.addEventListener("click", () => {
    // If not on cart page – navigate there instead of optimizing
    if (!isOnCartPage) {
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          chrome.tabs.update(tabs[0].id, { url: "https://allegro.pl/koszyk" }, () => {
            window.close();
          });
        } else {
          chrome.tabs.create({ url: "https://allegro.pl/koszyk" }, () => window.close());
        }
      });
      return;
    }

    if (!activeTabId) return;

    // Reset temporary states in storage and trigger optimization
    chrome.storage.local.set({
      aco_state: "scraping_cart",
      aco_cart_items: [],
      aco_all_offers: [],
      aco_current_item_index: 0,
      aco_optimized_list: [],
      aco_optimized_results: null,
      aco_current_recreate_index: 0,
      aco_initial_totals: null,
      aco_logs: []
    }, () => {
      // Reload tab to guarantee content script injection and startup
      chrome.tabs.reload(activeTabId, {}, () => {
        window.close(); // Close popup
      });
    });
  });

  // 4. Cancel/Reset optimization button handler
  resetBtn.addEventListener("click", () => {
    chrome.storage.local.set({ aco_state: "idle" }, () => {
      loadStatistics();
      updatePopupUI();
      // Send reset message to active tab content script
      chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
        if (tabs && tabs[0]) {
          chrome.tabs.sendMessage(tabs[0].id, { action: "resetState" }, () => {
            if (chrome.runtime.lastError) {
              // Ignore if content script is not injected
            }
          });
        }
      });
    });
  });

  // Handler for resetting statistics
  resetStatsBtn.addEventListener("click", () => {
    if (confirm("Czy na pewno chcesz wyzerować swoje statystyki oszczędności?")) {
      chrome.storage.local.set({
        aco_stats: {
          total_optimizations: 0,
          total_saved: 0.0,
          average_saved: 0.0,
          max_single_saved: 0.0
        }
      }, () => {
        loadStatistics();
      });
    }
  });

  // Listen to changes in storage to update statistics/state in real time
  chrome.storage.onChanged.addListener((changes) => {
    if (changes.aco_state || changes.aco_stats) {
      loadStatistics();
      updatePopupUI();
    }
  });

  // Initial load
  loadStatistics();
  updatePopupUI();
});
