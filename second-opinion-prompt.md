## Kontext aplikácie

Zvonček je interný CRM pre malú webdesign firmu (3-5 ľudí). Rieši dva procesy:
1. **Telesales** obvoláva nové kontakty (cold calling), loguje výsledky hovorov (nezdvihli, nemajú záujem, majú záujem, zavolať neskôr...)
2. **Manažér** spravuje aktívne obchodné príležitosti (pipeline) — cenové ponuky, návrhy, ďalšie kroky

Obe časti majú koncept "ďalší krok / kedy zavolať znova", uložený ako dátum (+ voliteľne čas) v databáze.

## Problém, ktorý riešime

Keď telesales agent alebo manažér nastavuje "kedy znova kontaktovať", reálny support pre toto je nejednoznačný:

- Niekedy klient povie **presný čas**: "zavolajte mi za hodinu", "zavolajte zajtra o 9:00" — toto je skutočný dohodnutý termín.
- Niekedy klient povie len **vágny deň, bez času**: "zavolajte mi v piatok" — agent možno vyplní nejaký čas (napr. 10:00) len ako svoj odhad, nie ako niečo čo klient skutočne povedal.
- Existuje aj úplne vágna kategória ("ozvite sa o pár mesiacov", "na jeseň") — vždy bez presného času, samostatný flow v UI.

**Kľúčová otázka:** Ako odlíšiť "toto je skutočne dohodnutý presný čas" od "toto je len deň, prípadne s odhadnutým časom navyše" — bez toho, aby sme pri každom jednom hovore pridávali extra checkbox/rozhodnutie, ktoré by telesales agent musel riešiť desiatky krát denne?

**Navrhované riešenie tejto časti:** Rozdeliť input na dátum (povinný) + čas (voliteľný, samostatné pole). Ak agent čas nevyplní, automaticky sa to berie ako "nepresný čas, len deň". Ak čas vyplní, berie sa to ako "presný, dohodnutý čas". Rýchle tlačidlá v UI ("O hodinu", "Zajtra ráno") generujú presný čas automaticky (sú priamy preklad toho čo klient povedal). Vágny "o pár mesiacov" flow je vždy nepresný, bez ohľadu na vyplnený dátum.

## Druhý problém: ako to vizuálne zobraziť (urgency states)

Aplikácia má teraz len binárne "preštvihnuté áno/nie" (červené, ak je dátum/čas v minulosti), počítané naživo pri každom requeste (nie historicky uložené).

Problém s binárnym modelom: ak agent nastaví len odhadnutý čas (napr. 9:00, hoci klient nepovedal nič presné), systém to ukáže ako "MEŠKÁŠ" (červené) hneď ako 9:00 prejde — a zostane to červené nezmenené celé hodiny až do polnoci. Keď neskôr v ten deň skutočne nastane vhodný moment zavolať, vizuálne sa nič nezmenilo (bolo to červené už od rána) — signál stráca informačnú hodnotu.

**Diskutovaný návrh riešenia** (potrebujem od teba nezávislé zhodnotenie, nie potvrdenie):

Existuje formatter dátumov, ktorý už dnešný deň zobrazuje ako text "Dnes" (alebo "Dnes 14:00" ak je čas súčasťou). Navrhovaný model využíva práve tento text na nesenie informácie, a farby len pre dva nové stavy:

| Stav | S presným časom | Bez presného času | Vzhľad |
|---|---|---|---|
| Budúce | pred dňom termínu | pred dňom termínu | obyčajný text ("15.3. 14:00" / "Piatok") |
| Dnes, čakaj | dnes, viac než 30 min do termínu | *(neexistuje — pre nepresný čas sa "dnes" rovná rovno "konaj")* | obyčajný text, formatter urobí "Dnes 14:00" |
| Dnes, konaj | *(neexistuje — pri presnom čase je "konaj" len posledných 30 min)* | celý deň termínu | obyčajný text, formatter urobí "Dnes" (bez času) |
| Blíži sa | posledných ~30 minút pred presným časom | — | oranžová |
| Mešká | po presnom čase | od polnoci nasledujúceho dňa | červená |

Teda: žiadny extra badge na "Dnes, čakaj" vs "Dnes, konaj" — rozdiel medzi "čakaj" a "konaj" sa necháva čisto na tom, či text obsahuje aj čas, alebo len deň. Iba "Blíži sa" (oranžová) a "Mešká" (červená) sú nové vizuálne stavy. Pôvodne sa zvažoval aj medzistupeň "Je čas" (červený text, predtým než sa červené pozadie + pulse animácia spustí ako "naozaj mešká") — v aktuálnej verzii bol tento medzistupeň zrušený, pretože sa usúdilo, že keď je raz správne odlíšený presný/nepresný čas pri zdroji, "červené hneď ako čas/deň prejde" už nie je predčasné, takže netreba ďalší medzistupeň.

## Čo potrebujem od teba

Vyhodnoť to ako produktový/UX problém, nezávisle, bez ohľadu na to, ktorá strana diskusie (ktorú nevidíš) navrhla čo. Odpovedaj **jednoznačne a úprimne**, nielen aby si potvrdil prvý návrh, na ktorý narazíš — ak niečo nedáva zmysel, povedz to priamo a navrhni alternatívu.

Konkrétne ma zaujíma:
1. Je rozlíšenie "presný čas vs. len deň" cez voliteľné pole (čas vyplnený/nevyplnený) dostatočne spoľahlivý signál, alebo je tu skrytá diera?
2. Je redukcia na "len 2 nové farby + existujúci text formatter" správny smer, alebo je to príliš zjednodušené a stratili sme dôležitú informáciu?
3. Malo by "Mešká" mať nejakú ďalšiu eskaláciu v čase (napr. po niekoľkých hodinách/dňoch sa zvýrazní ešte viac), alebo je to over-engineering pre interný nástroj s 3-5 používateľmi?
4. Akékoľvek iné diery alebo lepšie riešenia, ktoré som/sme nezvážili.
