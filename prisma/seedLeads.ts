// prisma/seedLeads.ts
import prisma from "@/lib/db";

// Realistické dáta presne v štýle, ako ich pridáva N:
// väčšinou meno + číslo, niekedy len web + číslo, občas poznámka, občas nastrelená cena
const leads = [
  { companyName: "Autoservis Kováč", phone: "0905 123 456" },
  { companyName: "Pekáreň u Janky", phone: "0911 222 333", note: "stará stránka, len základné info" },
  { website: "stolarstvo-novak.sk", phone: "0948 555 666" },
  { companyName: "Kvetinárstvo Ruža", phone: "0902 777 888" },
  { companyName: "Zámočníctvo Hruška", phone: "0915 444 111" },
  { website: "instalater-bb.sk", phone: "0917 333 222", note: "web nefunguje dobre na mobile" },
  { companyName: "Penzión Lúčka", phone: "0903 666 999" },
  { companyName: "Účtovníctvo Malá", phone: "0908 121 212" },
  { website: "elektro-stary.sk", phone: "0944 989 898" },
  { companyName: "Fitness Centrum Sila", phone: "0907 565 656", note: "majiteľ p. Novák" },

  { companyName: "Kaderníctvo Vlnka", phone: "0918 343 434" },
  { companyName: "Stavebniny Tehla", phone: "0901 232 323" },
  { website: "autodoprava-juh.sk", phone: "0949 878 787" },
  { companyName: "Cukráreň Sladká", phone: "0911 454 545", note: "web nemajú vôbec" },
  { companyName: "Klampiarstvo Plech", phone: "0905 676 767" },
  { companyName: "Reštaurácia U Medveďa", phone: "0904 234 567" },
  { website: "penzionpodlesom.sk", phone: "0910 987 654" },
  { companyName: "Masáže Harmónia", phone: "0948 111 222" },
  { companyName: "Autoumyváreň Lesk", phone: "0902 333 444", note: "majú iba Facebook stránku" },
  { website: "kovovyroba-marek.sk", phone: "0917 765 432" },

  { companyName: "Zubná ambulancia Smile", phone: "0903 222 111" },
  { companyName: "Veterinárna ambulancia Labka", phone: "0915 555 444" },
  { website: "sklenarstvo-milan.sk", phone: "0944 101 202", note: "starý dizajn stránky" },
  { companyName: "Pizzeria Toscana", phone: "0908 303 404" },
  { companyName: "Kaviareň Roh", phone: "0911 606 707" },
  { website: "taxi-sever.sk", phone: "0905 808 909" },
  { companyName: "Jazyková škola Lingua", phone: "0949 222 333" },
  { companyName: "Detské centrum Slniečko", phone: "0918 444 555", note: "potrebujú lepšiu prezentáciu služieb" },
  { website: "strechy-pokryvac.sk", phone: "0907 777 888" },
  { companyName: "Kúrenárstvo Horák", phone: "0910 333 222" },

  { companyName: "Elektroinštalácie Blesk", phone: "0948 909 101" },
  { website: "malovaniebytov.sk", phone: "0904 121 343" },
  { companyName: "Svadobný salón Bella", phone: "0915 787 878" },
  { companyName: "Optika Jasný Zrak", phone: "0902 454 545" },
  { website: "realitka-domov.sk", phone: "0917 232 323", note: "stránka pôsobí neaktuálne" },
  { companyName: "Nábytok na mieru Stolár", phone: "0944 565 656" },
  { companyName: "Kozmetický salón Ema", phone: "0908 676 767" },
  { website: "servis-pc-ba.sk", phone: "0911 989 898" },
  { companyName: "Tanečná škola Tempo", phone: "0905 343 434" },
  { companyName: "Pneuservis Rýchlo", phone: "0949 121 212", note: "majú len jednoduchú vizitku" },

  { companyName: "Záhradníctvo Tulipán", phone: "0903 454 321" },
  { website: "cisteniekobercov.sk", phone: "0918 565 432" },
  { companyName: "Fotograf Studio Lux", phone: "0907 111 333" },
  { companyName: "Autoškola Sprint", phone: "0910 222 444" },
  { website: "opravastrech.sk", phone: "0948 333 555" },
  { companyName: "Kamenárstvo Granit", phone: "0904 444 666" },
  { companyName: "Lakovňa AutoColor", phone: "0915 555 777" },
  { website: "drevenedomceky.sk", phone: "0902 666 888", note: "pekné produkty, slabá stránka" },
  { companyName: "Pohrebníctvo Tichý", phone: "0917 777 999" },
  { companyName: "Čalúnnictvo Komfort", phone: "0944 888 111" },

  { companyName: "Potraviny U Nás", phone: "0908 999 222" },
  { website: "wellness-zelena.sk", phone: "0911 111 444" },
  { companyName: "Hotel Panorama", phone: "0905 222 555" },
  { companyName: "Rehabilitácia Pohyb", phone: "0949 333 666" },
  { website: "eshop-matrace.sk", phone: "0903 444 777", note: "eshop pôsobí zastaralo" },
  { companyName: "Tlačiareň PrintMax", phone: "0918 555 888" },
  { companyName: "Klimatizácie CoolAir", phone: "0907 666 999" },
  { website: "plastoveokna-region.sk", phone: "0910 777 111" },
  { companyName: "Súkromná škôlka Hviezdička", phone: "0948 888 222" },
  { companyName: "Gastro servis GastroFix", phone: "0904 999 333" },

  { companyName: "Vinotéka U Sudu", phone: "0915 101 202" },
  { website: "svadobneozdoby.sk", phone: "0902 202 303" },
  { companyName: "Rybolov Centrum", phone: "0917 303 404" },
  { companyName: "Krajčírstvo Ihla", phone: "0944 404 505", note: "nemajú vlastný web" },
  { website: "cykloservis-peter.sk", phone: "0908 505 606" },
  { companyName: "Právna kancelária Lexa", phone: "0911 606 707" },
  { companyName: "Finančné poradenstvo Plus", phone: "0905 707 808" },
  { website: "upratovanie-domacnosti.sk", phone: "0949 808 909" },
  { companyName: "Dvere a podlahy Domex", phone: "0903 909 101" },
  { companyName: "Servis bielej techniky", phone: "0918 121 323" },

  { companyName: "Piváreň Na rohu", phone: "0907 232 434" },
  { website: "keramika-rucne.sk", phone: "0910 343 545" },
  { companyName: "Lahôdky Marta", phone: "0948 454 656" },
  { companyName: "Dopravná firma TransLine", phone: "0904 565 767" },
  { website: "sidlisko-fitness.sk", phone: "0915 676 878", note: "stránka má slabé fotky" },
  { companyName: "Predajňa farieb Kolor", phone: "0902 787 989" },
  { companyName: "Kaviareň Botanika", phone: "0917 898 191" },
  { website: "bazeny-servis.sk", phone: "0944 919 292" },
  { companyName: "Domáce potreby Eva", phone: "0908 292 393" },
  { companyName: "Rodinný penzión Pod horou", phone: "0911 393 494", note: "web existuje, ale vyzerá staro" },
];

async function main() {
    console.log("DATABASE_URL:", process.env.DATABASE_URL);

    for (const lead of leads) {
        await prisma.lead.create({
            data: lead, // status NEW je default → všetky pristanú v /calls
        });
    }

    console.log(`Seeded ${leads.length} leads ✅`);
}

main().finally(() => prisma.$disconnect());