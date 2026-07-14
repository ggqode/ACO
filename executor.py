import time
import random
from playwright.sync_api import sync_playwright

def random_delay(min_s=1.0, max_s=3.0):
    time.sleep(random.uniform(min_s, max_s))

class AllegroExecutor:
    def __init__(self, page):
        self.page = page

    def clear_cart(self):
        print("[Executor] Przystępuję do czyszczenia obecnego koszyka...")
        self.page.goto("https://allegro.pl/koszyk", wait_until="domcontentloaded")
        print("[Executor] Sprawdź okno przeglądarki na wypadek CAPTCHA/DataDome (czekam do 60s)...")
        try:
            self.page.wait_for_selector("div[data-box-name='cart'], button[data-cy='offer-row.remove'], a[href*='/oferta/']", timeout=60000)
        except Exception as e:
            print(f"[Executor] Ostrzeżenie podczas czekania na koszyk: {e}")
            
        self.page.wait_for_timeout(3000)
        
        # Omijanie ewentualnego okna cookies
        try:
            cookie_btn = self.page.locator("button[data-role='accept-consent']").first
            if cookie_btn.is_visible(timeout=2000):
                cookie_btn.click()
                self.page.wait_for_timeout(1000)
        except:
            pass

        # Sposób 1: Usuwanie zbiorcze (Bulk delete)
        try:
            dropdown = self.page.locator("button[id='delete-offers.dropdown'], button:has-text('usuń')").first
            if dropdown.is_visible(timeout=3000):
                print("[Executor] Wykryto przycisk usuwania zbiorczego. Próbuję usunąć wszystko na raz...")
                dropdown.click()
                self.page.wait_for_timeout(1000)
                
                delete_all = self.page.locator("button[data-cy='delete-offers.all'], button:has-text('usuń wszystko')").first
                if delete_all.is_visible(timeout=2000):
                    delete_all.click()
                    self.page.wait_for_timeout(2000)
                    
                    # Wyszukiwanie przycisku potwierdzenia w modalnym oknie
                    confirm_selectors = [
                        "button[data-analytics-interaction-label='removeAllConfirm']",
                        "div[role='dialog'] button:has-text('Usuń')",
                        "div[role='dialog'] button:has-text('usuń')",
                        "button:has-text('usuń wszystko')",
                        "button:has-text('Usuń')"
                    ]
                    
                    confirmed = False
                    for selector in confirm_selectors:
                        btn = self.page.locator(selector).first
                        if btn.is_visible(timeout=1000):
                            print(f"[Executor] Klikam przycisk potwierdzenia: {selector}")
                            btn.click()
                            self.page.wait_for_timeout(4000)
                            confirmed = True
                            break
                            
                    if confirmed:
                        print("[Executor] Koszyk wyczyszczony zbiorczo.")
                        return
        except Exception as e:
            print(f"[Executor] Błąd podczas czyszczenia zbiorczego: {e}. Przechodzę do czyszczenia pozycjami...")

        # Sposób 2 (Fallback): Usuwanie pozycjami po kolei
        print("[Executor] Rozpoczynam usuwanie produktów po kolei...")
        while True:
            try:
                self.page.wait_for_timeout(1000)
                
                delete_locators = self.page.locator("button[data-cy='offer-row.remove'], button[aria-label^='Usuń przedmiot']").all()
                if not delete_locators:
                    delete_locators = self.page.locator("button[aria-label*='Usuń z koszyka'], button[aria-label*='Usuń ofertę']").all()
                
                if not delete_locators:
                    print("[Executor] Koszyk jest pusty (brak przycisków usuwania).")
                    break
                    
                print(f"[Executor] Znaleziono {len(delete_locators)} przedmiotów w koszyku. Usuwam pierwszy...")
                delete_locators[0].click(force=True)
                self.page.wait_for_timeout(2500)
            except Exception as e:
                print(f"[Executor] Błąd podczas usuwania przedmiotu: {e}")
                break

    def add_to_cart(self, offer_id, quantity):
        url = f"https://allegro.pl/oferta/{offer_id}"
        print(f"[Executor] Dodaję {quantity} szt. oferty {offer_id} ({url})")
        
        self.page.goto(url, wait_until="domcontentloaded")
        print("[Executor] Sprawdź okno przeglądarki na wypadek CAPTCHA (czekam do 60s)...")
        try:
            self.page.wait_for_selector("button:has-text('DODAJ DO KOSZYKA'), button:has-text('Dodaj do koszyka')", timeout=60000)
        except:
            pass
        self.page.wait_for_timeout(3000)
        random_delay()
        
        # Omijanie modala z ciasteczkami jeśli się pojawi na nowej podstronie
        try:
            cookie_btn = self.page.locator("button[data-role='accept-consent']")
            if cookie_btn.is_visible(timeout=1000):
                cookie_btn.click()
        except:
            pass
            
        # Zmiana ilości (wyszukaj input ilości)
        if quantity > 1:
            # Często jest to input[type="number"] z max, min
            qty_input = self.page.locator("input[type='number']").first
            if qty_input.count() > 0:
                try:
                    # W Allegro może być zablokowany typowaniem z palca, 
                    # czasami lepiej naciskać przycisk '+' jeśli istnieje, 
                    # ale fill() zazwyczaj działa w React po symulacji zdarzeń
                    qty_input.fill(str(quantity))
                    qty_input.press("Enter")
                    self.page.wait_for_timeout(1000)
                except Exception as e:
                    print(f"[Executor] Błąd podczas zmiany ilości: {e}")
            else:
                print(f"[Executor] Ostrzeżenie: Nie znaleziono inputa zmiany ilości dla {offer_id}. Upewnij się, że dodano {quantity} szt. ręcznie, lub sprawdź DOM.")

        # Przycisk dodawania do koszyka
        try:
            # Selektory przycisku dodaj do koszyka: 
            # button[id="add-to-cart-button"] (stare) 
            # button zawierający tekst "DODAJ DO KOSZYKA"
            add_btn = self.page.locator("button", has_text="DODAJ DO KOSZYKA").first
            
            if add_btn.count() == 0:
                add_btn = self.page.locator("button", has_text="Dodaj do koszyka").first
                
            if add_btn.count() > 0:
                add_btn.click()
                print(f"[Executor] Sukces: kliknięto Dodaj do koszyka dla {offer_id}.")
                self.page.wait_for_timeout(3000)
            else:
                print(f"[Executor] Nie znaleziono przycisku 'Dodaj do koszyka' dla oferty {offer_id}. Może wygasła lub zmienił się design.")
        except Exception as e:
            print(f"[Executor] Błąd klikania 'Dodaj do koszyka': {e}")
            
    def run(self, optimized_list):
        self.clear_cart()
        
        for item in optimized_list:
            self.add_to_cart(item['offer_id'], item['quantity'])
            random_delay(2, 5)
            
        print("[Executor] Odtwarzanie zoptymalizowanego koszyka zakończone.")
