import type { MetadataRoute } from "next";

// PWA manifest – Next servíruje na /manifest.webmanifest a sám pridá <link>.
// Ikony sú odložené v public/images/logo/icons (čierna dlaždica, biele telo + akcent).
export default function manifest(): MetadataRoute.Manifest {
    return {
        id: "/",
        name: "Zvonček",
        short_name: "Zvonček",
        description: "Interný CRM – The Grand Points",
        start_url: "/",
        scope: "/",
        lang: "sk",
        dir: "ltr",
        display: "standalone",
        orientation: "any", // responzívne – na tablete aj na šírku, nefixujeme portrait
        background_color: "#0a0a0a",
        theme_color: "#0a0a0a",
        categories: ["business", "productivity"],
        icons: [
            {
                src: "/images/logo/icons/icon-192.png",
                sizes: "192x192",
                type: "image/png",
            },
            {
                src: "/images/logo/icons/icon-512.png",
                sizes: "512x512",
                type: "image/png",
            },
            {
                src: "/images/logo/icons/icon-512-maskable.png",
                sizes: "512x512",
                type: "image/png",
                purpose: "maskable",
            },
        ],
        shortcuts: [
            {
                name: "Volania",
                short_name: "Volania",
                description: "Fronta volaní",
                url: "/dashboard/calls",
            },
            {
                name: "Pipeline",
                short_name: "Pipeline",
                description: "Manažérska pipeline",
                url: "/dashboard/pipeline",
            },
            {
                name: "Nový kontakt",
                short_name: "Kontakt",
                description: "Pridať nový kontakt",
                url: "/dashboard/contacts/new",
            },
        ],
    };
}
