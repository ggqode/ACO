import os

# --- KONFIGURACJA PRZEGLĄDARKI ---
# Domyślna przeglądarka (opcje: "chrome", "edge", "opera", "operagx")
# Jeśli chcesz, by skrypt zawsze pytał o wybór, ustaw na None.
DEFAULT_BROWSER = ""

HEADLESS_MODE = False  # Zgodnie z wymaganiem, przeglądarka ma być widoczna

# --- KONFIGURACJA LOGIKI ALLEGRO ---
SMART_THRESHOLD = 45.0  # Kwota darmowej dostawy ze Smart
DEFAULT_SHIPPING_COST = 15.0  # Domyślny koszt wysyłki (gdy nie uda się zeskrapować dokładnego)

# Plik tymczasowy do zapisu danych
CART_DATA_FILE = "dane_koszyka.json"
