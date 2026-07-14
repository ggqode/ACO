/**
 * ACO - Cart Optimizer
 * Plik konfiguracyjny – SZABLON dla społeczności (config.example.js)
 *
 * Skopiuj ten plik jako `config.production.js` i uzupełnij własne wartości.
 * NIE umieszczaj swoich prawdziwych parametrów afiliacyjnych w tym pliku.
 *
 * Instrukcja:
 *   1. Skopiuj: cp config.example.js config.production.js
 *   2. Uzupełnij PARAMS_SHARE własnymi parametrami (lub zostaw puste).
 *   3. Upewnij się, że config.production.js jest w .gitignore.
 */

var CONFIG_MONETIZATION = {
  /**
   * Parametry afiliacyjne dołączane do URL przy wyborze "Z poleceniem".
   * Przykład: "?utm_medium=afiliacja&utm_source=ctr_2&utm_campaign=TWOJE_ID"
   * Zostaw pusty string "", aby wyłączyć tryb z poleceniem.
   */
  PARAMS_SHARE: ""
};
