import json
import time
import random
import re
from playwright.sync_api import sync_playwright
from bs4 import BeautifulSoup
import config

def human_delay(min_s=1.0, max_s=3.0):
    time.sleep(random.uniform(min_s, max_s))

def simulate_human_action(page):
    """Udaje ruchy myszki człowieka przed przejściem dalej."""
    try:
        # Losowy ruch myszką
        for _ in range(random.randint(2, 5)):
            x = random.randint(100, 800)
            y = random.randint(100, 800)
            page.mouse.move(x, y)
            time.sleep(random.uniform(0.1, 0.4))
    except:
        pass

class AllegroScraper:
    def __init__(self, page):
        self.page = page

    def get_cart_items(self):
        """Zbiera informacje o przedmiotach obecnie w koszyku."""
        print("[Scraper] Sprawdzam, czy jesteśmy już w koszyku...")
        if "/koszyk" not in self.page.url:
            print("[Scraper] Wchodzę do koszyka Allegro...")
            self.page.goto("https://allegro.pl/koszyk", wait_until="domcontentloaded")
        else:
            print("[Scraper] Strona koszyka jest już otwarta, odczytuję zawartość...")
        
        human_delay(1.5, 3.5)
        simulate_human_action(self.page)
        
        print("[Scraper] UWAGA: Sprawdź okno przeglądarki. Jeśli widzisz CAPTCHA lub Cloudflare, rozwiąż to teraz.")
        print("[Scraper] Skrypt czeka (do 60 sekund) na załadowanie zawartości...")
        try:
            self.page.wait_for_selector("a[href*='/oferta/']", timeout=60000)
        except:
            pass
        
        # Udawanie, że człowiek czyta stronę i delikatnie scrolluje
        human_delay(2.0, 4.0)
        try:
            scroll_y = random.randint(300, 500)
            self.page.mouse.wheel(0, scroll_y)
        except:
            pass
        human_delay(1.0, 2.0)
        
        # Pobieranie całego kodu źródłowego
        html_content = self.page.content()
        soup = BeautifulSoup(html_content, "lxml")
        
        with open("debug_cart.html", "w", encoding="utf-8") as f:
            f.write(html_content)
        
        cart_offers = {}
        
        # Szukanie wszystkich linków do ofert w pobranym HTML-u
        offer_links = soup.find_all("a", href=re.compile(r'/oferta/'))
        
        for link in offer_links:
            href = link.get("href")
            if not href:
                continue
            
            match = re.search(r'/oferta/.*?-?(\d{8,14})', href)
            if not match:
                continue
            
            offer_id = match.group(1)
            
            quantity = 1
            curr = link
            for _ in range(6):
                if not curr:
                    break
                inputs = curr.find_all("input")
                found = False
                for inp in inputs:
                    val = inp.get("value")
                    # Na Allegro ilość to zazwyczaj input z małą wartością liczbową
                    if val and val.isdigit() and 0 < len(val) < 4:
                        # Upewniamy się, że to nie jest jakiś checkbox (np. val="1" i type="checkbox")
                        if inp.get("type") not in ["checkbox", "radio", "hidden"]:
                            quantity = int(val)
                            found = True
                            break
                if found:
                    break
                curr = curr.parent

            if offer_id not in cart_offers:
                cart_offers[offer_id] = {
                    "original_url": href,
                    "offer_id": offer_id,
                    "quantity": quantity
                }
            else:
                if quantity > 1:
                    cart_offers[offer_id]["quantity"] = quantity

        print(f"[Scraper] Znaleziono {len(cart_offers)} unikalnych ofert w koszyku (przez BS4).")
        
        # Wyciągamy podsumowanie początkowe koszyka
        try:
            self.initial_totals = self.extract_initial_totals(soup)
        except Exception as e:
            print(f"[Scraper] Nie udało się odczytać podsumowania kosztów koszyka: {e}")
            self.initial_totals = {
                "products_cost": 0.0,
                "shipping_cost": 0.0,
                "total_cost": 0.0
            }
            
        return list(cart_offers.values())

    def extract_initial_totals(self, soup):
        text = soup.get_text()
        
        def clean_price(val_str):
            cleaned = val_str.replace(" ", "").replace("\xa0", "").replace(",", ".").strip()
            return float(cleaned)
            
        prod_matches = list(re.finditer(r'Wartość\s+produktów\s*([\d\s\xa0]+[.,]\d{2})', text, re.IGNORECASE))
        charity_matches = list(re.finditer(r'Na\s+cele\s+charytatywne\s*([\d\s\xa0]+[.,]\d{2})', text, re.IGNORECASE))
        ship_matches = list(re.finditer(r'Dostawa\s+od\s*([\d\s\xa0]+[.,]\d{2})', text, re.IGNORECASE))
        total_matches = list(re.finditer(r'Razem\s+z\s+dostawą\s*([\d\s\xa0]+[.,]\d{2})', text, re.IGNORECASE))
        
        totals = {
            "products_cost": 0.0,
            "shipping_cost": 0.0,
            "total_cost": 0.0
        }
        
        if prod_matches:
            totals["products_cost"] = clean_price(prod_matches[-1].group(1))
        
        if charity_matches:
            charity_cost = clean_price(charity_matches[-1].group(1))
            totals["products_cost"] = round(totals["products_cost"] + charity_cost, 2)
            print(f"[Scraper] Znaleziono datek charytatywny: {charity_cost} zł. Włączono go do wartości produktów.")
            
        if ship_matches:
            totals["shipping_cost"] = clean_price(ship_matches[-1].group(1))
        if total_matches:
            totals["total_cost"] = clean_price(total_matches[-1].group(1))
            
        # Wyliczenie dostawy na podstawie różnicy, jeśli total i products są dostępne, a dostawy nie znaleziono
        if totals["total_cost"] > 0 and totals["products_cost"] > 0 and totals["shipping_cost"] == 0:
            totals["shipping_cost"] = round(totals["total_cost"] - totals["products_cost"], 2)
            
        print(f"[Scraper] Odczytane koszty początkowe koszyka: Produkty={totals['products_cost']} zł, Dostawa={totals['shipping_cost']} zł, Razem={totals['total_cost']} zł")
        return totals


    def get_alternative_offers(self, item):
        """Zbiera alternatywne oferty dla danego przedmiotu."""
        url = item['original_url']
        if url.startswith("/"):
            url = f"https://allegro.pl{url}"
        
        # Usuwamy ewentualny hash i parametry, zostawiamy czysty URL oferty
        base_url = url.split("#")[0].split("?")[0]
        
        # Dodajemy parametry: sortowanie wg ceny, tylko "Kup teraz", nowe oferty, strona 1
        alt_url = base_url + "?order=p&buyNew=1&offerTypeBuyNow=1&p=1#inne-oferty-produktu"
        print(f"[Scraper] Szukam alternatyw pod adresem: {alt_url}")
        
        # wait_until="domcontentloaded" bo "commit" jest za wczesne dla SPA
        self.page.goto(alt_url, wait_until="domcontentloaded")
        
        # Czekamy aż JS wyrenderuje listing ofert (to jest kluczowe dla SPA!)
        print("[Scraper] Czekam na wyrenderowanie ofert przez JavaScript (max 30 sek)...")
        listing_found = False
        try:
            self.page.wait_for_selector(".opbox-listing li", timeout=30000)
            listing_found = True
            print("[Scraper] Listing ofert wyrenderowany!")
        except Exception as e:
            print(f"[Scraper] Timeout po 30s. Odświeżam stronę i czekam kolejne 30 sek...")
            try:
                self.page.reload(wait_until="domcontentloaded")
                
                # Sprawdzenie, czy po odświeżeniu wyskoczyła CAPTCHA
                content_lower = self.page.content().lower()
                if "captcha" in content_lower or "jesteś człowiekiem" in content_lower or "datadome" in content_lower or "limit zapytań" in content_lower:
                    print("\n" + "!"*50)
                    print("[UWAGA] Wykryto zabezpieczenie przed botami (CAPTCHA)!")
                    input("[UWAGA] Rozwiąż zadanie w oknie przeglądarki i wciśnij ENTER tutaj, aby kontynuować...\n")
                    print("[Scraper] Dziękuję. Wznawiam oczekiwanie na wyrenderowanie ofert...")
                    
                self.page.wait_for_selector(".opbox-listing li", timeout=30000)
                listing_found = True
                print("[Scraper] Listing ofert wyrenderowany po odświeżeniu!")
            except Exception as e2:
                print(f"[Scraper] Drugi timeout po odświeżeniu. Rezygnuję z czekania na pobranie tej strony ofert.")
        
        # Ludzki scroll po wyrenderowaniu
        simulate_human_action(self.page)
        human_delay(2.0, 3.5)
        try:
            self.page.mouse.wheel(0, random.randint(300, 500))
        except:
            pass
        human_delay(1.5, 3.0)
        
        # Dopiero TERAZ pobieramy HTML – po tym jak JS wyrenderował treść
        html_content = self.page.content()
        soup = BeautifulSoup(html_content, "lxml")
        
        # === DIAGNOSTYKA - zapisujemy HTML do analizy ===
        debug_path = f"debug_page_{item['offer_id']}.html"
        with open(debug_path, "w", encoding="utf-8") as f:
            f.write(html_content)
            
        # === NOWE: Wyciąganie JSON z tagów script ===
        import json
        scripts_with_json = soup.find_all("script", attrs={"data-serialize-box-id": True})
        json_dumps = []
        for i, s in enumerate(scripts_with_json):
            try:
                data = json.loads(s.string)
                json_dumps.append(data)
            except Exception as e:
                pass
                
        if json_dumps:
            json_debug_path = f"debug_json_{item['offer_id']}.json"
            with open(json_debug_path, "w", encoding="utf-8") as f:
                json.dump(json_dumps, f, indent=2, ensure_ascii=False)
            print(f"[Scraper] ZNALEZIONO {len(json_dumps)} JSONów z danymi! Zapisano do: {json_debug_path}")

        # Pobieramy prawdziwy product_id z link rel="canonical"
        product_id_group = item['offer_id']
        canonical = soup.find("link", rel="canonical")
        if canonical and canonical.get("href"):
            match = re.search(r'-([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})', canonical.get("href"))
            if match:
                product_id_group = match.group(1)
        
        offers_data = []
        
        # 1. PARSOWANIE Z JSON (Najbardziej niezawodne dla SPA Allegro)
        parsed_from_json = False
        if json_dumps:
            for obj in json_dumps:
                if isinstance(obj, dict) and '__listing_StoreState' in obj:
                    elements = obj['__listing_StoreState'].get('items', {}).get('elements', [])
                    for el in elements:
                        try:
                            offer_id_val = el.get('id')
                            if not offer_id_val or not str(offer_id_val).isdigit():
                                continue
                                
                            seller_name = el.get('seller', {}).get('login', "Nieznany")
                            
                            price_val = 9999.0
                            price_str = el.get('price', {}).get('mainPrice', {}).get('amount')
                            if price_str:
                                price_val = float(price_str)
                                
                            smart = False
                            freebox = el.get('freebox', {})
                            if freebox and 'labels' in freebox:
                                for label in freebox['labels']:
                                    for part in label.get('labelParts', []):
                                        if 'Smart!' in part.get('text', ''):
                                            smart = True
                                            break
                                            
                            shipping_cost = config.DEFAULT_SHIPPING_COST
                            ship_data = el.get('shipping', {})
                            if ship_data:
                                lowest = ship_data.get('lowest', {}).get('amount')
                                if lowest:
                                    shipping_cost = float(lowest)
                                    
                            available_stock = el.get('quantity', 999)
                                    
                            offers_data.append({
                                "product_id_group": product_id_group,
                                "base_offer_id": item['offer_id'],
                                "offer_id": str(offer_id_val),
                                "seller": seller_name,
                                "price": price_val,
                                "is_smart": smart,
                                "shipping_cost": shipping_cost,
                                "stock": available_stock
                            })
                        except Exception as e:
                            print(f"[Scraper] Błąd podczas parsowania oferty z JSON: {e}")
                    
                    if len(offers_data) > 0:
                        parsed_from_json = True
                        print(f"[Scraper] Sukces! Sparsowano {len(offers_data)} ofert prosto z ukrytego JSONa.")
                        break

        # 2. FALLBACK - HTML
        if not parsed_from_json:
            print("[Scraper] JSON nie zawierał ofert, wracam do awaryjnego parsowania HTML...")
            all_opbox = soup.select("[class*='opbox-listing']")
            all_li_count = len(soup.select("li"))
            all_offer_links = soup.find_all("a", href=re.compile(r'/oferta/'))
            
            listing_container = soup.select_one(".opbox-listing")
            if not listing_container:
                listing_items = []
                for a in all_offer_links:
                    li_parent = a.find_parent("li")
                    if li_parent and li_parent not in listing_items:
                        listing_items.append(li_parent)
            else:
                listing_items = listing_container.select("li")
                listing_items = [li for li in listing_items if li.find("a", href=re.compile(r'/oferta/'))]
                
            for li in listing_items:
                try:
                    a_tag = li.find("a", href=re.compile(r'/oferta/'))
                    if not a_tag or not a_tag.get("href"):
                        continue
                    href = a_tag.get("href")
                    if href.startswith("/"):
                        href = f"https://allegro.pl{href}"
                    match = re.search(r'-(\d{8,14})', href)
                    if not match:
                        match = re.search(r'(\d{8,14})$', href.rstrip('/'))
                    if not match:
                        continue
                    offer_id_val = match.group(1)
                        
                    seller_tag = li.find("a", href=re.compile(r'/uzytkownik/'))
                    seller_name = seller_tag.get_text(strip=True) if seller_tag else "Nieznany"
                    
                    price_val = 9999.0
                    price_p = li.select_one("p[aria-label*='aktualna cena']")
                    if price_p:
                        aria = price_p.get("aria-label", "")
                        m = re.search(r'([\d\s]+[,\.][\d]{2})\s*zł', aria)
                        if m:
                            price_val = float(m.group(1).replace(" ", "").replace(",", "."))
                    else:
                        text = li.get_text()
                        matches = re.findall(r'([\d]+[,\.][\d]{2})\s*zł', text)
                        if matches:
                            prices = [float(m.replace(",", ".")) for m in matches]
                            price_val = min(p for p in prices if p > 0.5)
                            
                    is_smart = bool(li.select_one("button[aria-label*='Allegro Smart!']"))
                        
                    shipping_cost = config.DEFAULT_SHIPPING_COST
                    if not is_smart:
                        ship_elem = li.select_one("div:contains('dostawa')")
                        if ship_elem:
                            m_ship = re.search(r'([\d\s]+[,\.][\d]{2})\s*zł\s*z\s*dostawą', ship_elem.text)
                            if m_ship:
                                shipping_cost = float(m_ship.group(1).replace(" ", "").replace(",", ".")) - price_val
                            
                    available_stock = 999
                    li_text_lower = li.get_text().lower()
                    if "ostatnia sztuka" in li_text_lower:
                        available_stock = 1
                    elif "ostatnie 2 sztuki" in li_text_lower:
                        available_stock = 2
                    else:
                        available_stock = 999
                        
                    offers_data.append({
                        "product_id_group": product_id_group,
                        "base_offer_id": item['offer_id'],
                        "offer_id": str(offer_id_val),
                        "seller": seller_name,
                        "price": price_val,
                        "is_smart": is_smart,
                        "shipping_cost": shipping_cost,
                        "stock": available_stock
                    })
                except Exception as e:
                    print(f"[Scraper] Błąd podczas parsowania pojedynczej oferty HTML: {e}")

        if not offers_data:
            print("[Scraper] UWAGA: Nie wyodrębniono żadnych ofert dla tego przedmiotu. Używam wyłącznie oryginalnej z koszyka.")
            offers_data.append({
                "product_id_group": product_id_group,
                "base_offer_id": item['offer_id'],
                "offer_id": item['offer_id'],
                "seller": "Obecny z koszyka",
                "price": 9999.0, # Bezpieczny, wysoki fallback
                "is_smart": False,
                "shipping_cost": config.DEFAULT_SHIPPING_COST,
                "stock": 999
            })

        # Wstawiamy parametr 'required_quantity' do każdej oferty w grupie, żeby solver wiedział
        for o in offers_data:
            o['required_quantity'] = item.get('quantity', 1)

        print(f"[Scraper] Zebrano {len(offers_data)} ofert dla produktu {item['offer_id']}.")
        return offers_data

    def run(self):
        cart_items = self.get_cart_items()
        all_offers = []
        
        for idx, item in enumerate(cart_items):
            print(f"--- Przedmiot {idx+1}/{len(cart_items)} ---")
            scraped_qty = item.get('quantity', 1)
            print(f"Zeskrapowana ilość dla {item['offer_id']} to {scraped_qty}.")
            
            offers = self.get_alternative_offers(item)
            
            # Wstawiamy parametr 'required_quantity' do każdej oferty w grupie, żeby solver wiedział
            for o in offers:
                o['required_quantity'] = item.get('quantity', 1)
                
            all_offers.extend(offers)
            
        data_to_save = {
            "initial_totals": getattr(self, "initial_totals", {
                "products_cost": 0.0,
                "shipping_cost": 0.0,
                "total_cost": 0.0
            }),
            "offers": all_offers
        }
        
        with open(config.CART_DATA_FILE, "w", encoding="utf-8") as f:
            json.dump(data_to_save, f, ensure_ascii=False, indent=2)
            
        print(f"[Scraper] Zapisano w sumie {len(all_offers)} ofert oraz koszty początkowe do {config.CART_DATA_FILE}.")
        return all_offers
