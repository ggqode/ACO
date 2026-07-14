# Polityka Prywatności – ACO - Cart Optimizer

Ostatnia aktualizacja: 12 lipca 2026 r.

Projekt **ACO - Cart Optimizer** (zarówno w postaci skryptu Python, jak i rozszerzenia do przeglądarki Chrome/Brave/Edge/Opera) został stworzony z myślą o pełnej ochronie prywatności użytkowników.

### 1. Działanie w 100% lokalne
Wszystkie operacje, w tym:
* Odczytywanie zawartości koszyka,
* Wyszukiwanie ofert alternatywnych w serwisie Allegro,
* Optymalizacja matematyczna (MILP za pomocą silnika HiGHS WebAssembly),
* Odtwarzanie/modyfikacja koszyka,

odbywają się **wyłącznie lokalnie** na Twoim komputerze. Rozszerzenie działa w piaskownicy (sandbox) przeglądarki i nie komunikuje się z żadnymi serwerami zewnętrznymi poza oficjalnymi domenami Allegro.

### 2. Brak zbierania i przetwarzania danych osobowych
Rozszerzenie **nie zbiera, nie zapisuje, nie przetwarza ani nie przesyła**:
* Żadnych danych logowania (loginów, haseł, sesji ciasteczek),
* Danych osobowych (nazwisk, adresów dostaw, numerów telefonów),
* Danych płatniczych (numerów kart, kont bankowych, transakcji BLIK),
* Historii wyszukiwania ani nawigacji.

### 3. Pamięć lokalna przeglądarki (`chrome.storage.local`)
Dodatek zapisuje w lokalnej pamięci Twojej przeglądarki wyłącznie:
* Informacje o produktach w Twoim koszyku niezbędne do przeprowadzenia obliczeń optymalizacyjnych,
* Twoje statystyki oszczędności (łączna zaoszczędzona kwota, liczba optymalizacji), które możesz w każdej chwili wyczyścić przyciskiem „Wyzeruj” w menu dodatku,
* Ustawienia dodatku (np. włączenie trybu bezpiecznego).

Dane te są przechowywane lokalnie na Twoim urządzeniu i nigdy nie są nikomu udostępniane.

### 4. Zmiany w polityce prywatności
Wszelkie przyszłe zmiany w polityce prywatności będą publikowane bezpośrednio w tym pliku w repozytorium projektu.

### 5. Kontakt
W razie pytań dotyczących prywatności, zachęcamy do kontaktu poprzez zgłoszenia (Issues) na profilu GitHub projektu.
