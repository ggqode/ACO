# Migracja nawigacji ACO: Ukryty iframe zamiast otwierania kart

## Opis problemu

Obecna architektura ACO działa poprzez nawigację `window.location.href`, co powoduje pełne przeładowania strony przy każdym kroku:
- Przy zbieraniu alternatyw: N produktów × pełny reload = N migań ekranu
- Przy odtwarzaniu koszyka: M ofert × pełny reload = M migań ekranu

Celem jest zastąpienie tej nawigacji **ukrytym iframe wstrzykiwanym do DOM** przez Content Script, tak aby scraping i dodawanie do koszyka odbywały się w tle – całkowicie niewidocznie dla użytkownika.

## Analiza obecnej architektury

```
State Machine w content.js:
  scraping_cart    → window.location.href (do strony oferty)
  scraping_alternatives → window.location.href (kolejne oferty)
  recreating_cart  → window.location.href (kolejne oferty)
  
  Każde przejście = pełne przeładowanie strony = miganie ekranu
```

### Kluczowe miejsca nawigacji w `content.js`:
- **L968**: `window.location.href = https://allegro.pl/oferta/${first.offer_id}?order=p...` (start scrapowania alternatyw)
- **L1022**: `window.location.reload()` (fallback timeout)
- **L1210**: `window.location.href = https://allegro.pl/oferta/${nextItem.offer_id}?...` (kolejna alternatywa)
- **L1262**: `window.location.href = "https://allegro.pl/koszyk"` (po optymalizacji)
- **L1375**: `window.location.href = buildOfferUrl(...)` (start odtwarzania)
- **L1461**: `window.location.href = buildOfferUrl(...)` (kolejna oferta do dodania)
- **L1487**: `window.location.href = "https://allegro.pl/koszyk"` (koniec)

## Ważna kwestia techniczna

> [!IMPORTANT]
> **Ograniczenie Content Security Policy Allegro:** Strony Allegro (allegro.pl) posiadają nagłówek CSP `frame-ancestors 'none'` lub podobne restrykcje, które **mogą blokować embeddowanie allegro.pl wewnątrz iframe**. Musimy uwzględnić fallback.
>
> Jednak – kluczowa obserwacja: Content Script rozszerzenia działa na stronie hosta, więc iframe wstrzyknięty przez CS z `src="https://allegro.pl/..."` korzysta z **ciasteczek sesji użytkownika**. CSP `frame-ancestors` jest sprawdzane przez przeglądarkę, ale można je obejść przez **tryb `srcdoc` z fetch() przez background service worker** (który może robić cross-origin requests z rozszerzenia i ma `origin: chrome-extension://...`), albo przez **`XMLHttpRequest` z poziomu content script** (który ma dostęp do cookies domeny).
>
> **Proponowane rozwiązanie:** Używamy `fetch()` bezpośrednio z Content Script (który ma uprawnienia do `allegro.pl` z cookies) do pobrania HTML podstrony, a następnie wstrzykujemy go do `iframe[srcdoc]`. To omija frame-ancestors CSP, bo iframe nie ładuje URL – ładuje HTML z `srcdoc`. Skrypty w srcdoc iframe nie mają jednak dostępu do cookies, więc interaktywne działania (klikanie "Dodaj do koszyka") musimy wykonywać inaczej.
>
> **Ostateczne podejście:** Hybrydowe – HTML pobieramy fetch-em z Content Script, parsujemy dane, bez potrzeby renderowania interaktywnego iframe dla scrapowania. Dla "Dodaj do koszyka" używamy bezpośrednio **Fetch API + POST do Allegro API** (jeśli możliwe) lub iframe z `src` URL.

## Ważna decyzja projektowa

> [!WARNING]
> **Podejście z iframe `src=` URL:** Jeśli Allegro stosuje nagłówek `X-Frame-Options: DENY` lub CSP `frame-ancestors: none`, iframe z `src=` URL zostanie zablokowany przez przeglądarkę. Widoczne byłoby to jako błąd w iframe.
>
> **Podejście z fetch() + srcdoc:** Omija frame-ancestors, ale iframe srcdoc nie ma cookies – więc "Dodaj do koszyka" (wymagające logowania) nie zadziała.
>
> **Najlepsze podejście dla SCRAPOWANIA alternatyw:** `fetch()` z Content Script (ma cookies) → parsowanie HTML odpowiedzi → ekstrakcja danych. **Zero iframe-ów**. Pełna niewidzialność.
>
> **Dla DODAWANIA do koszyka:** Iframe z `src=` URL – po załadowaniu Content Script w iframe klika przycisk. Jeśli frame-ancestors blokuje – fallback do `window.location.href` tylko dla tej operacji.

## Proponowana architektura

### Nowy przepływ dla `scraping_alternatives`:

```
[Główny CS na stronie koszyka]
  ↓
Iteracja po cartList:
  → fetch("https://allegro.pl/oferta/{id}?order=p&...") z Content Script (cookies included)
  → parsowanie otrzymanego HTML przez DOMParser()
  → ekstrakcja danych ofert (scripts, DOM)
  → zebranie wszystkich ofert w pamięci
  → dopiero po wszystkich → state "optimizing" → solver
```

**Zalety:** Użytkownik przez cały czas widzi overlay ACO z paskiem postępu na stronie koszyka. Zero migania.

### Nowy przepływ dla `recreating_cart`:

```
[Główny CS na stronie koszyka]
  ↓
Tworzenie hidden iframe (0×0px, position: absolute, visibility: hidden)
  → iframe.src = buildOfferUrl(offer_id)
  → Czekamy na onload iframe-a
  → Content Script WEWNĄTRZ iframe klika "Dodaj do koszyka"
  → Wysyła postMessage: { type: "ACO_ITEM_ADDED", success: true/false, offerIndex: N }
  → Główny CS odbiera wiadomość → usuwa iframe → tworzy nowy dla kolejnego produktu
```

**Fallback:** Jeśli iframe się nie załaduje (frame-ancestors) → fallback do window.location.href (obecne zachowanie).

### Detekcja CAPTCHA w iframe:

```
[Content Script w iframe]
  → sprawdza URL iframe: url.includes("captcha") || url.includes("challenge")
  → sprawdza DOM: document.querySelector(".cf-challenge, #challenge-form, [data-captcha]")
  → jeśli CAPTCHA: postMessage({ type: "ACO_CAPTCHA_DETECTED" })
  
[Główny CS]
  → odbiera ACO_CAPTCHA_DETECTED
  → zmienia styl iframe: position: fixed, width: 400px, height: 550px, z-index: 9999999, display: block
  → renderuje modal wrapper z nagłówkiem "Potwierdź, że jesteś człowiekiem..."
  → gdy CAPTCHA rozwiązana: postMessage({ type: "ACO_CAPTCHA_SOLVED" }) → wraca do ukrytego
```

## Planowane zmiany

### 1. Nowy moduł: `IframeNavigator` (w `content.js`)

Klasa zarządzająca cyklem życia ukrytego iframe:
- `createHiddenIframe(url)` → tworzy i wstrzykuje iframe
- `revealAsCaptchaModal()` → przekształca w modal
- `hideAgain()` → z powrotem ukrywa
- `destroy()` → usuwa z DOM
- `waitForLoad()` → Promise rozwiązywana po `onload`

### 2. Nowa funkcja: `fetchAndParseAlternatives(item)` (w `content.js`)

Zastępuje przejście `window.location.href` dla etapu `scraping_alternatives`:
- `fetch(url, { credentials: "include" })` → pobiera HTML
- `new DOMParser().parseFromString(html, "text/html")` → parsuje
- Uruchamia istniejącą logikę ekstrakcji z `runScrapeAlternatives` na sparsowanym dokumencie (a nie `document`)
- **Cały scraping odbywa się w pętli `for` na stronie koszyka** – zero nawigacji

### 3. Refaktoryzacja `runScrapeAlternatives(item, index, total)` 

Oddzielenie logiki ekstrakcji danych od nawigacji:
- `extractAlternativesFromDoc(doc, item)` → czysta funkcja pracująca na dowolnym Document
- Wywoływana zarówno przez nową fetch-pętlę (na sparsowanym doc), jak i jako fallback na żywym document

### 4. Refaktoryzacja `recreating_cart` → iframe-based

- Nowa funkcja `addItemViaIframe(item, index, useShare)` → Promise
- Obsługa `postMessage` między iframe CS a głównym CS
- CAPTCHA modal fallback
- Usunięcie `window.location.href` z `runAddToCart`

### 5. Zmiana `runScrapeCart`

- Usunięcie `window.location.href` na koniec
- Zastąpienie pętlą `for...of` wywołującą `fetchAndParseAlternatives` dla każdego produktu
- Overlay aktualizowany między iteracjami przez `overlay.showWorking()`

### 6. Stan `scraping_alternatives` – uproszczenie

Stan `scraping_alternatives` staje się wewnętrznym etapem `scraping_cart` (nie wymaga już oddzielnego stanu w state machine bo nie ma navigacji między stronami). Jednak dla kompatybilności backwards pozostawiamy go w state machine.

### 7. Aktualizacja ostrzeżenia w overlay

Zmiana tekstu z *"ACO będzie automatycznie przechodzić pomiędzy stronami Allegro"* na *"ACO pracuje w tle. Nie zamykaj tej karty."*

### 8. Nowe style CSS w `overlay.css`

Style dla modala CAPTCHA:
```css
#aco-captcha-iframe-wrapper { ... }
#aco-captcha-iframe-wrapper iframe { ... }
.aco-captcha-header { ... }
```

## Pliki do modyfikacji

### [MODIFY] [content.js](file:///c:/Users/Kacper/AllegroCart/extension/content.js)

#### Zmiany:
1. **L657-L969**: Dodanie klasy `IframeNavigator`
2. **L964-L969**: Refaktoryzacja `runScrapeCart` – zamiast `window.location.href` uruchamia pętlę `fetchAndParseAlternatives`
3. **L1006-L1217**: Refaktoryzacja `runScrapeAlternatives` + nowa `extractAlternativesFromDoc(doc, item)`
4. **L1390-L1496**: Refaktoryzacja `runAddToCart` → `addItemViaIframe` + fallback
5. **L373**: Aktualizacja tekstu ostrzeżenia w overlay
6. **L1503-L1515**: Dodanie `window.addEventListener("message", ...)` dla komunikacji z iframe

### [MODIFY] [overlay.css](file:///c:/Users/Kacper/AllegroCart/extension/overlay.css)

Dodanie stylów dla CAPTCHA modal iframe wrapper.

## Weryfikacja planu

### Testy automatyczne
- Brak istniejących testów jednostkowych – weryfikacja manualna

### Weryfikacja manualna
1. Otworzyć allegro.pl/koszyk z produktami
2. Uruchomić optymalizację → obserwować czy ekran nie miga podczas scraping_alternatives
3. Zatwierdzić optymalizację → obserwować czy ekran nie miga podczas recreating_cart
4. Sprawdzić, czy CAPTCHA modal pojawia się poprawnie gdy Allegro rzuci challenge
5. Sprawdzić fallback gdy iframe jest blokowany przez CSP

## Pytania otwarte

> [!IMPORTANT]
> **Q1:** Czy chcesz zachować całkowity fallback do obecnego zachowania (`window.location.href`) gdy wykryjemy, że iframe jest blokowany przez CSP Allegro? Czy preferujesz żeby wtedy całkowicie zamiesić proces z komunikatem błędu?

> [!IMPORTANT]  
> **Q2:** Dla etapu `scraping_alternatives` – proponuję użyć `fetch()` z Content Script (najczyściej, bez iframe). Czy akceptujesz to podejście, czy chcesz koniecznie iframe dla tego etapu też?

> [!IMPORTANT]
> **Q3:** Dla etapu `recreating_cart` (dodawanie do koszyka) – wymaga interakcji z DOM (kliknięcia przycisku w zalogowanej sesji). Proponuję iframe z `src=` URL (Content Script w iframe klika przycisk). Akceptowalny fallback do window.location.href jeśli iframe zablokowany?
