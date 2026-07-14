# ACO - Cart Optimizer 🚀

**ACO - Cart Optimizer** to darmowe narzędzie, które automatycznie optymalizuje Twój koszyk w serwisie Allegro. Algorytm znajduje najtańsze kombinacje ofert od różnych sprzedawców, maksymalizując wykorzystanie darmowej dostawy **Allegro Smart!** przy jednoczesnej minimalizacji kosztu produktów i wysyłek płatnych.

Dzięki wykorzystaniu profesjonalnego silnika matematycznego **HiGHS** skompilowanego do **WebAssembly**, dodatek wykonuje pełną optymalizację liniową (MILP) bezpośrednio w Twojej przeglądarce w ułamku sekundy, gwarantując odnalezienie matematycznego optimum.

---

## ⚠️ Zastrzeżenie Prawne (Disclaimer)

**Korzystasz z tego oprogramowania na własną odpowiedzialność.** 

1. **Brak powiązania:** Projekt jest niezależnym rozwiązaniem typu Open Source. Nie jest w żaden sposób powiązany, autoryzowany, sponsorowany ani popierany przez Allegro sp. z o.o. ani podmioty powiązane.
2. **Wyłączenie odpowiedzialności:** Autor oprogramowania nie ponosi żadnej odpowiedzialności za jakiekolwiek szkody wynikające z użytkowania bota/rozszerzenia, w tym za:
   - Ewentualne zablokowanie, ograniczenie lub zawieszenie konta na Allegro z powodu naruszenia regulaminu serwisu (korzystanie z automatycznych skryptów/botów robisz na własne ryzyko),
   - Błędy w zamówieniach (np. dodanie niewłaściwej liczby sztuk, błędnej oferty lub pominięcie pozycji),
   - Zmiany cen produktów lub kosztów wysyłki w trakcie działania bota,
   - Jakiekolwiek inne straty finansowe lub niefinansowe.
3. **Weryfikacja zamówienia:** Przed ostatecznym kliknięciem "Kupuję i płacę" na Allegro, **zawsze dokładnie sprawdź podsumowanie koszyka** – upewnij się, że zawiera właściwe produkty, ilości oraz wybrane metody dostawy.

---

## ✨ Funkcje
- 🔍 **Automatyczne skanowanie:** Pobiera zawartość koszyka oraz wyszukuje alternatywne oferty dla każdego produktu.
- 🧮 **Silnik MILP w WebAssembly (HiGHS):** Dokładnie modeluje progi darmowej dostawy Smart! (np. min. 45 zł u jednego sprzedawcy) jako liniowe ograniczenia matematyczne.
- ⚡ **Szybkość:** Rozwiązuje skomplikowane problemy optymalizacyjne w czasie poniżej 300 ms lokalnie.
- 🤖 **Tryb bezpieczny (Anti-Captcha):** Emuluje naturalne zachowania użytkownika (ruch myszką, losowe opóźnienia) w celu zmniejszenia ryzyka blokad.
- 📊 **Statystyki oszczędności:** Śledzi Twoje łączne oszczędności uzyskane dzięki dodatkowi bezpośrednio w okienku popup.

---

## 🔧 Instrukcja Instalacji (Chrome / Brave / Edge / Opera)

Ponieważ dodatek jest w fazie rozwojowej / Open Source, najprościej załadować go w trybie deweloperskim:

1. **Pobierz repozytorium:** Pobierz kod projektu i rozpakuj go na dysku.
2. **Otwórz stronę rozszerzeń:** W przeglądarce przejdź pod adres:
   - **Chrome:** `chrome://extensions/`
   - **Brave:** `brave://extensions/`
   - **Edge:** `edge://extensions/`
   - **Opera:** `opera://extensions/`
3. **Włącz Tryb Dewelopera:** Zaznacz suwak *Tryb programisty / Tryb dewelopera* (zazwyczaj w prawym górnym lub lewym dolnym rogu ekranu).
4. **Załaduj rozszerzenie:** Kliknij przycisk **„Załaduj rozpakowane”** (Load unpacked) i wskaż folder o nazwie `extension` znajdujący się wewnątrz pobranego projektu.
5. Gotowe! Ikona **ACO** pojawi się na Twoim pasku rozszerzeń.

---

## ☕ Wsparcie / Buy me a coffee

Jeśli dodatek zaoszczędził Ci realne pieniądze przy zakupach i chcesz podziękować autorowi, możesz postawić mi wirtualną kawę! Każde wsparcie motywuje do dalszego rozwijania projektu.

Możesz to zrobić błyskawicznie przez BLIK / kartę klikając w poniższy link:

👉 **[Postaw kawę na BuyCoffee.to](https://buycoffee.to/ggqode)**

Dziękuję za każde wsparcie! ❤️

---

## 📝 Licencja

Projekt jest dostępny na warunkach **Licencji GPLv3**. Szczegóły znajdziesz w pliku [LICENSE](https://github.com/ggqode/ACO/blob/main/LICENSE).
