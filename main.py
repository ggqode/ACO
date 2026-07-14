import os
import sys
import shutil
import subprocess
import time
from playwright.sync_api import sync_playwright

import config
from scraper import AllegroScraper
from optimizer import CartOptimizer
from executor import AllegroExecutor

# Katalog roboczy dla bota - kopia profilu Chrome (Chrome blokuje remote debugging na domyślnym profilu)
BOT_PROFILE_DIR = os.path.join(os.path.dirname(__file__), "bot_chrome_profile")

def prepare_bot_profile(src_profile_dir):
    """
    Kopiuje pliki sesji z oryginalnego profilu wybranej przeglądarki do katalogu bota.
    Przeglądarki blokują remote debugging (wymagane przez Playwright) na domyślnym profilu.
    Kopiujemy pliki ciasteczek/sesji, by Playwright mógł z nich skorzystać w oddzielnym folderze.
    """
    dst_default = os.path.join(BOT_PROFILE_DIR, "Default")
    os.makedirs(dst_default, exist_ok=True)
    
    # Pliki kluczowe dla sesji Allegro
    session_files = ["Cookies", "Login Data", "Login Data For Account", 
                     "Web Data", "Preferences", "Secure Preferences"]
    
    copied = []
    for fname in session_files:
        src = os.path.join(src_profile_dir, fname)
        dst = os.path.join(dst_default, fname)
        if os.path.exists(src):
            try:
                shutil.copy2(src, dst)
                copied.append(fname)
            except Exception as e:
                print(f"[Main] Pomijam {fname}: {e}")
                
    if not copied:
        print(f"\n[Warning] Nie skopiowano żadnych plików sesji z: {src_profile_dir}")
        print("Upewnij się, że poprawna przeglądarka została wybrana oraz że jesteś na niej zalogowany na Allegro.\n")
    else:
        print(f"[Main] Skopiowano pliki sesji bota: {copied}")

def main():
    print("========================================")
    print("    ACO - CART OPTIMIZER BOT 2.0        ")
    print("========================================\n")
    
    # Wybór przeglądarki
    browser_choice = getattr(config, "DEFAULT_BROWSER", None)
    if not browser_choice or browser_choice.lower() not in ["chrome", "edge", "opera", "operagx"]:
        print("Wybierz przeglądarkę, z której chcesz przenieść sesję Allegro:")
        print("1. Google Chrome")
        print("2. Microsoft Edge")
        print("3. Opera Stable")
        print("4. Opera GX")
        choice = input("Wybierz (1-4) [domyślnie 1]: ").strip()
        if choice == "2":
            browser_choice = "edge"
        elif choice == "3":
            browser_choice = "opera"
        elif choice == "4":
            browser_choice = "operagx"
        else:
            browser_choice = "chrome"
    else:
        browser_choice = browser_choice.lower()
        print(f"[Main] Wybrano przeglądarkę z konfiguracji: {browser_choice.upper()}")

    # Ustalanie ścieżek profilu i binariów
    local_app_data = os.environ.get("LOCALAPPDATA", "")
    app_data = os.environ.get("APPDATA", "")
    
    src_profile_dir = ""
    executable_path = None
    channel = None
    proc_name = ""

    if browser_choice == "chrome":
        src_profile_dir = os.path.join(local_app_data, r"Google\Chrome\User Data\Default")
        channel = "chrome"
        proc_name = "chrome.exe"
    elif browser_choice == "edge":
        src_profile_dir = os.path.join(local_app_data, r"Microsoft\Edge\User Data\Default")
        channel = "msedge"
        proc_name = "msedge.exe"
    elif browser_choice == "opera":
        src_profile_dir = os.path.join(app_data, r"Opera Software\Opera Stable")
        proc_name = "opera.exe"
        # Lokalizacje launchera Opery
        opera_paths = [
            os.path.join(local_app_data, r"Programs\Opera\launcher.exe"),
            r"C:\Program Files\Opera\launcher.exe",
            r"C:\Program Files (x86)\Opera\launcher.exe"
        ]
        for path in opera_paths:
            if os.path.exists(path):
                executable_path = path
                break
    elif browser_choice == "operagx":
        src_profile_dir = os.path.join(app_data, r"Opera Software\Opera GX Stable")
        proc_name = "opera.exe"
        # Lokalizacje launchera Opery GX
        operagx_paths = [
            os.path.join(local_app_data, r"Programs\Opera GX\launcher.exe"),
            r"C:\Program Files\Opera GX\launcher.exe",
            r"C:\Program Files (x86)\Opera GX\launcher.exe"
        ]
        for path in operagx_paths:
            if os.path.exists(path):
                executable_path = path
                break

    # Automatyczne zamykanie procesów przeglądarki, żeby odblokować pliki profilu i ciasteczka
    if proc_name:
        print(f"[Main] Zamykam procesy {proc_name} w celu odblokowania bazy sesji...")
        subprocess.run(["taskkill", "/F", "/IM", proc_name, "/T"], 
                       capture_output=True, text=True)
        # Na wypadek gdyby Opera miała proces o nazwie launcher.exe
        if "opera" in browser_choice:
            subprocess.run(["taskkill", "/F", "/IM", "launcher.exe", "/T"], 
                           capture_output=True, text=True)
        time.sleep(2)

    # Przygotowanie kopii profilu z sesją Allegro
    print(f"[Main] Kopiuję sesję z {browser_choice.upper()} do katalogu roboczego bota...")
    prepare_bot_profile(src_profile_dir)
    print(f"[Main] Profil bota: {BOT_PROFILE_DIR}\n")
    
    input("Wciśnij ENTER, aby uruchomić bota...")

    try:
        with sync_playwright() as p:
            print(f"\n[Main] Uruchamianie bota na silniku {browser_choice.upper()}...")
            
            # Parametry launch persistent context
            launch_args = {
                "user_data_dir": BOT_PROFILE_DIR,
                "headless": config.HEADLESS_MODE,
                "viewport": {"width": 1280, "height": 800},
                "ignore_default_args": ["--enable-automation", "--no-sandbox", "--disable-blink-features=AutomationControlled"],
                "args": ["--disable-infobars"]
            }
            
            if channel:
                launch_args["channel"] = channel
            if executable_path:
                launch_args["executable_path"] = executable_path
                
            browser_context = p.chromium.launch_persistent_context(**launch_args)
            
            # Używamy pierwszej domyślnej karty jeśli istnieje, lub tworzymy nową (unikamy otwierania 2 kart)
            if browser_context.pages:
                page = browser_context.pages[0]
            else:
                page = browser_context.new_page()
            page.bring_to_front()
            
            # Włączenie maskowania wg. instrukcji (zaawansowany stealth)
            stealth_js = """
            // 1. Ukrywamy flagę webdriver
            Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
            
            // 2. Zapobiegamy wykryciu przez testy sprawdzające czy navigator.webdriver został nadpisany
            // (Nadpisanie getter'a zrzuca błąd jeśli skrypt anty-botowy poprosi o jego definicję)
            
            // Ponieważ używamy prawdziwego profilu Google Chrome (channel='chrome', headless=False), 
            // NIE MUSIMY fałszować karty graficznej, języków ani wtyczek - przeglądarka podaje Twoje prawdziwe, ludzkie dane.
            // Ich sztuczne nadpisywanie wręcz ułatwiłoby wykrycie bota!
            """
            page.add_init_script(stealth_js)

            # --- KROK 1: SCRAPING ---
            scraper = AllegroScraper(page)
            
            # Przechodzimy od razu do koszyka
            print("[Main] Otwieram stronę koszyka Allegro...")
            page.goto("https://allegro.pl/koszyk", wait_until="domcontentloaded")
            
            print("\n" + "="*50)
            print("  KROK 1: Uzupełnij koszyk w oknie przeglądarki")
            print("="*50)
            print("  Przeglądarka otworzyła się bezpośrednio na Twoim koszyku.")
            print("  Dodaj lub modyfikuj produkty w koszyku w przeglądarce.")
            print("  UWAGA: NIE ZAMYKAJ OKNA PRZEGLĄDARKI po skończeniu!")
            print("  Skrypt będzie dalej korzystał z tego okna do działania.")
            print("  Gdy wszystko będzie gotowe, wróć do konsoli i wciśnij ENTER.")
            print("="*50)
            input("\n  [>>] Wciśnij ENTER gdy koszyk jest gotowy: ")
            print("\n[Main] Startuję scrapowanie koszyka...")
            
            # Próba odzyskania karty, jeśli użytkownik jednak ją zamknął lub użył innej
            try:
                if page.is_closed():
                    print("[Main] Wykryto zamknięcie pierwotnej karty, szukam otwartej...")
                    open_pages = [p for p in browser_context.pages if not p.is_closed()]
                    if open_pages:
                        page = open_pages[-1]
                        page.bring_to_front()
                    else:
                        page = browser_context.new_page()
                    scraper.page = page
            except Exception as e:
                print(f"[Main] Ostrzeżenie podczas odzyskiwania strony: {e}")
            
            # Ta funkcja przechodzi po koszyku, potem po stronach #inne-oferty-produktu i zapisuje do JSON
            scraper.run()

            # --- KROK 2: OPTYMALIZACJA ---
            optimizer = CartOptimizer()
            optimized_results = optimizer.optimize()

            if not optimized_results:
                print("\n[Main] Optymalizator nie zwrócił wyników. Przerywam.")
                browser_context.close()
                sys.exit(0)

            # --- KROK 3: ODTWARZANIE KOSZYKA ---
            print("\n[Main] Czy przystąpić do odtworzenia zoptymalizowanego koszyka na koncie?")
            ans = input("Wpisz 'T' (Tak) lub 'N' (Nie): ")
            if ans.lower() in ['t', 'tak']:
                try:
                    if page.is_closed():
                        open_pages = [p for p in browser_context.pages if not p.is_closed()]
                        if open_pages:
                            page = open_pages[-1]
                        else:
                            page = browser_context.new_page()
                except Exception:
                    pass
                executor = AllegroExecutor(page)
                executor.run(optimized_results)
            else:
                print("[Main] Anulowano zmianę koszyka.")

            # Wyświetlamy podsumowanie oszczędności ponownie na sam koniec!
            optimizer.print_savings()

            if not config.HEADLESS_MODE:
                print("[Main] Sukces! Koszyk został pomyślnie zaktualizowany.")
                print("Przeglądarka pozostanie otwarta, byś mógł zweryfikować koszyk przed zakupem.")
                print("Możesz teraz bezpiecznie zamknąć to okno terminala.")
                # Nieskończona pętla na czekanie aż użytkownik sam zamknie skrypt
                while True:
                    time.sleep(10)

    except Exception as e:
        print(f"\n[CRITICAL ERROR] Wystąpił błąd główny aplikacji: {e}")

if __name__ == "__main__":
    main()
