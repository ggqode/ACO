import json
import pulp
import config

class CartOptimizer:
    def __init__(self, data_file=config.CART_DATA_FILE):
        with open(data_file, "r", encoding="utf-8") as f:
            data = json.load(f)
            if isinstance(data, dict):
                self.offers = data.get("offers", [])
                self.initial_totals = data.get("initial_totals", {})
            else:
                self.offers = data
                self.initial_totals = {}

    def optimize(self):
        print("\n[Optimizer] Rozpoczynam optymalizację koszyka (MILP)...")
        if not self.offers:
            print("[Optimizer] Brak ofert do optymalizacji.")
            return []

        # Zbieramy zbiory
        # I - produkty (identyfikowane przez product_id_group)
        # J - sprzedawcy (identyfikowani przez nazwe sprzedawcy)
        
        products = list(set([o['product_id_group'] for o in self.offers]))
        sellers = list(set([o['seller'] for o in self.offers]))
        
        # Wymagane ilości produktów (Q) - musimy zsumować ilości z różnych ofert koszyka (base_offer_id)
        # dla tego samego produktu (product_id_group), aby zsumować, gdy ktoś doda to samo z różnych sklepów.
        Q = {}
        base_offers_seen = set()
        for o in self.offers:
            pid = o['product_id_group']
            bid = o.get('base_offer_id', pid) # fallback na pid, gdyby go nie było
            qty = o.get('required_quantity', 1)
            
            if bid not in base_offers_seen:
                base_offers_seen.add(bid)
                Q[pid] = Q.get(pid, 0) + qty
                
        # Zbudujmy strukturę parametrów ofert: 
        # Ponieważ dany sprzedawca może mieć kilka ofert tego samego produktu, 
        # weźmiemy tylko najtańszą ofertę danego produktu od danego sprzedawcy.
        
        # dict: (product, seller) -> best_offer_dict
        best_offers = {}
        for o in self.offers:
            key = (o['product_id_group'], o['seller'])
            if key not in best_offers or o['price'] < best_offers[key]['price']:
                best_offers[key] = o

        # Problem optymalizacyjny
        prob = pulp.LpProblem("AllegroCartOptimization", pulp.LpMinimize)

        # Przypisujemy ID dla uniknięcia duplikatów po usunięciu znaków spec.
        p_idx = {p: i for i, p in enumerate(products)}
        s_idx = {s: i for i, s in enumerate(sellers)}

        # Zmienne
        # x_ij: ile sztuk produktu i kupujemy od sprzedawcy j
        x = {}
        for p in products:
            for s in sellers:
                key = (p, s)
                if key in best_offers:
                    offer = best_offers[key]
                    max_stock = min(offer['stock'], Q[p])
                    x[key] = pulp.LpVariable(f"x_{p_idx[p]}_{s_idx[s]}", lowBound=0, upBound=max_stock, cat='Integer')

        # y_s: czy kupujemy cokolwiek od sprzedawcy s (0/1)
        y = {}
        for s in sellers:
            y[s] = pulp.LpVariable(f"y_{s_idx[s]}", cat='Binary')

        # z_s: czy płacimy za wysyłkę od sprzedawcy s (0/1)
        z = {}
        for s in sellers:
            z[s] = pulp.LpVariable(f"z_{s_idx[s]}", cat='Binary')

        # Ograniczenia
        # 1. Musimy kupić wymaganą ilość każdego produktu
        for i, p in enumerate(products):
            prob += pulp.lpSum([x[(p, s)] for s in sellers if (p, s) in x]) == Q[p], f"Req_{i}"

        # Big M do łączenia x i y (M = suma wszystkich Q, nie będziemy kupować więcej niż potrzebujemy w sumie od jednego sprzedawcy)
        M_total = sum(Q.values())

        for i, s in enumerate(sellers):
            # 2. Jeśli kupujemy cokolwiek, y_s musi być 1
            prob += pulp.lpSum([x[(p, s)] for p in products if (p, s) in x]) <= M_total * y[s], f"BuyAnything_{i}"

            # 3. Logika wysyłki:
            # Koszt Smart u danego sprzedawcy
            smart_cost_expr = pulp.lpSum([x[(p, s)] * best_offers[(p, s)]['price'] for p in products if (p, s) in x and best_offers[(p, s)]['is_smart']])
            
            # Wymuszenie z_s = 1, gdy (y_s == 1) ORAZ (smart_cost_expr < SMART_THRESHOLD)
            # Wtedy smart_cost_expr <= SMART_THRESHOLD - epsilon ORAZ chcemy płacić.
            # Zastosujemy trik: 
            # SMART_THRESHOLD * y[s] - smart_cost_expr <= SMART_THRESHOLD * z[s]
            # Dowód:
            # - Jeśli y[s]=0: x_ij=0, smart_cost=0. Lewa strona: 0 - 0 = 0. Zatem 0 <= z_s. (Cel zminimalizuje z_s do 0).
            # - Jeśli y[s]=1:
            #     a) smart_cost < 45 -> Lewa strona to (45 - smart) > 0. Więc 45 * z_s > 0 -> z_s MUSI być 1.
            #     b) smart_cost >= 45 -> Lewa strona to (45 - >=45) <= 0. Zatem liczba niedodatnia <= 45 * z_s. z_s MOŻE być 0 (i cel to zrobi).
            # Uproszczenie: zakłada, że dla Smart wysyłka jest 0, a dla nie-smart koszt = domyślny lub zeskrapowany.
            
            prob += config.SMART_THRESHOLD * y[s] - smart_cost_expr <= config.SMART_THRESHOLD * z[s], f"SmartLogic_{i}"
            
            # 4. Jeśli kupujemy, ale kupujemy TYLKO rzeczy bez Smarta, z_s musi być 1 niezależnie od kwoty.
            # Jeśli sprzedawca w ogóle nie ma smarta dla tych przedmiotów, smart_cost_expr będzie zawsze 0,
            # więc warunek z punktu 3 (45 * 1 - 0 <= 45 * z) wymusi z_s = 1. To genialnie załatwia sprawę!

        # Koszty wysyłki od poszczególnych sprzedawców (bierzemy np. maksymalny koszt dostawy z tych ofert od sprzedawcy, które kupujemy)
        # Aby zachować liniowość, weźmiemy średnią lub max z dostępnych u sprzedawcy i zrobimy parametr shipping_cost_s
        seller_shipping = {}
        for s in sellers:
            costs = [best_offers[(p, s)]['shipping_cost'] for p in products if (p, s) in x]
            seller_shipping[s] = max(costs) if costs else config.DEFAULT_SHIPPING_COST

        # Funkcja celu (minimalizacja kosztu)
        product_costs = pulp.lpSum([x[(p, s)] * best_offers[(p, s)]['price'] for p in products for s in sellers if (p, s) in x])
        shipping_costs = pulp.lpSum([z[s] * seller_shipping[s] for s in sellers])
        
        prob += product_costs + shipping_costs

        # Rozwiąż problem
        prob.solve(pulp.PULP_CBC_CMD(msg=0))

        if pulp.LpStatus[prob.status] != 'Optimal':
            print(f"[Optimizer] Solver nie znalazł optymalnego rozwiązania! Status: {pulp.LpStatus[prob.status]}")
            return []

        self.opt_prod_cost = pulp.value(product_costs)
        self.opt_ship_cost = pulp.value(shipping_costs)
        self.opt_total_cost = pulp.value(prob.objective)

        results = []
        for p in products:
            for s in sellers:
                key = (p, s)
                if key in x and x[key].varValue and x[key].varValue > 0:
                    qty = int(x[key].varValue)
                    offer_info = best_offers[key]
                    results.append({
                        "offer_id": offer_info['offer_id'],
                        "seller": s,
                        "product_group": p,
                        "price": offer_info['price'],
                        "quantity": qty
                    })
                    print(f"  KUPUJ: {qty} szt. od '{s}' (Oferta: {offer_info['offer_id']}, Cena: {offer_info['price']} zł)")
        
        # Wypisz koszty wysyłki wg sprzedawców
        for s in sellers:
            if y[s].varValue == 1.0:
                is_shipping = (z[s].varValue == 1.0)
                cost = seller_shipping[s] if is_shipping else 0.0
                print(f"  WYSYŁKA '{s}': {cost} zł")

        # Wyświetlamy podsumowanie i tabelę oszczędności
        self.print_savings()

        with open("zoptymalizowany_koszyk.json", "w", encoding="utf-8") as f:
            json.dump(results, f, ensure_ascii=False, indent=2)

        return results

    def print_savings(self):
        print("\n" + "="*60)
        print("                 PODSUMOWANIE OSZCZĘDNOŚCI")
        print("="*60)
        
        opt_prod = getattr(self, "opt_prod_cost", 0.0)
        opt_ship = getattr(self, "opt_ship_cost", 0.0)
        opt_total = getattr(self, "opt_total_cost", 0.0)
        
        if hasattr(self, "initial_totals") and self.initial_totals:
            init_prod = self.initial_totals.get("products_cost", 0.0)
            init_ship = self.initial_totals.get("shipping_cost", 0.0)
            init_total = self.initial_totals.get("total_cost", 0.0)
            
            saved_prod = init_prod - opt_prod
            saved_ship = init_ship - opt_ship
            saved_total = init_total - opt_total
            
            print(f"Przed optymalizacją (Twój początkowy koszyk):")
            print(f"  - Produkty:        {init_prod:8.2f} zł")
            print(f"  - Koszt dostawy:   {init_ship:8.2f} zł")
            print(f"  - RAZEM:           {init_total:8.2f} zł")
            print("-" * 60)
            print(f"Po optymalizacji (Nowy zoptymalizowany koszyk):")
            print(f"  - Produkty:        {opt_prod:8.2f} zł  (Zaoszczędzono: {saved_prod:6.2f} zł)")
            print(f"  - Koszt dostawy:   {opt_ship:8.2f} zł  (Zaoszczędzono: {saved_ship:6.2f} zł)")
            print(f"  - RAZEM:           {opt_total:8.2f} zł  (ZAOSZCZĘDZONO: {saved_total:6.2f} zł!)")
        else:
            print(f"Zoptymalizowany koszyk:")
            print(f"  - Produkty:        {opt_prod:8.2f} zł")
            print(f"  - Koszt dostawy:   {opt_ship:8.2f} zł")
            print(f"  - RAZEM:           {opt_total:8.2f} zł")
            print("  (Brak danych o kosztach początkowych w pliku JSON)")
        print("="*60 + "\n")
