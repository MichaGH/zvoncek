import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import Header from "@/components/layout/Header";
import ThemeProvider from "@/components/layout/ThemeProvider";
import { Toaster } from "sonner";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
    title: "Zvonček",
    description: "Interný CRM – The Grand Points",
    robots: {
        index: false,
        follow: false,
        googleBot: { index: false, follow: false },
    },
    icons: {
        // SVG je primárny (moderné prehliadače ho uprednostnia podľa type).
        // PNG je ľahký fallback pre staré prehliadače – žiadny ťažký .ico netreba.
        icon: [
            { url: "/images/logo/icons/favicon.svg", type: "image/svg+xml" },
            { url: "/images/logo/icons/favicon-48.png", type: "image/png", sizes: "48x48" },
        ],
        apple: [
            { url: "/images/logo/icons/apple-icon.png", sizes: "180x180" },
        ],
        // Safari pinned-tab – jednofarebná silueta, Safari ju vyfarbí na fialovo.
        other: [
            { rel: "mask-icon", url: "/images/logo/icons/icon-mask.svg", color: "#6d5df6" },
        ],
    },
    appleWebApp: {
        capable: true,
        title: "Zvonček",
        statusBarStyle: "default",
        // iOS splash – vygenerované cez pwa-asset-generator (vstup input_3000x3000.png,
        // pozadie #0a0a0a). Pokrýva aktuálne aj staršie Apple zariadenia, portrait + landscape.
        startupImage: [
            { url: "/images/logo/splash/apple-splash-2064-2752.png", media: "(device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2752-2064.png", media: "(device-width: 1032px) and (device-height: 1376px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-2048-2732.png", media: "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2732-2048.png", media: "(device-width: 1024px) and (device-height: 1366px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1668-2420.png", media: "(device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2420-1668.png", media: "(device-width: 834px) and (device-height: 1210px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1668-2388.png", media: "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2388-1668.png", media: "(device-width: 834px) and (device-height: 1194px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1668-2224.png", media: "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2224-1668.png", media: "(device-width: 834px) and (device-height: 1112px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1536-2048.png", media: "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2048-1536.png", media: "(device-width: 768px) and (device-height: 1024px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1640-2360.png", media: "(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2360-1640.png", media: "(device-width: 820px) and (device-height: 1180px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1620-2160.png", media: "(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2160-1620.png", media: "(device-width: 810px) and (device-height: 1080px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1488-2266.png", media: "(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2266-1488.png", media: "(device-width: 744px) and (device-height: 1133px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1320-2868.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2868-1320.png", media: "(device-width: 440px) and (device-height: 956px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1206-2622.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2622-1206.png", media: "(device-width: 402px) and (device-height: 874px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1260-2736.png", media: "(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2736-1260.png", media: "(device-width: 420px) and (device-height: 912px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1290-2796.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2796-1290.png", media: "(device-width: 430px) and (device-height: 932px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1179-2556.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2556-1179.png", media: "(device-width: 393px) and (device-height: 852px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1170-2532.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2532-1170.png", media: "(device-width: 390px) and (device-height: 844px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1284-2778.png", media: "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2778-1284.png", media: "(device-width: 428px) and (device-height: 926px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1080-2340.png", media: "(device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2340-1080.png", media: "(device-width: 360px) and (device-height: 780px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1242-2688.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2688-1242.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1125-2436.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2436-1125.png", media: "(device-width: 375px) and (device-height: 812px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-828-1792.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-1792-828.png", media: "(device-width: 414px) and (device-height: 896px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-1242-2208.png", media: "(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-2208-1242.png", media: "(device-width: 414px) and (device-height: 736px) and (-webkit-device-pixel-ratio: 3) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-750-1334.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-1334-750.png", media: "(device-width: 375px) and (device-height: 667px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
            { url: "/images/logo/splash/apple-splash-640-1136.png", media: "(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: portrait)" },
            { url: "/images/logo/splash/apple-splash-1136-640.png", media: "(device-width: 320px) and (device-height: 568px) and (-webkit-device-pixel-ratio: 2) and (orientation: landscape)" },
        ],
    },
};

// themeColor sa od Next 13 dáva do viewport (nie metadata). Ladí lištu prehliadača
// s hlavičkou appky: biela v light, navy v dark.
export const viewport: Viewport = {
    themeColor: [
        { media: "(prefers-color-scheme: light)", color: "#ffffff" },
        { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
    ],
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="sk"
      suppressHydrationWarning
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        <ThemeProvider>
          <Header />
          {children}
          <Toaster richColors position="top-center" />
        </ThemeProvider>
      </body>
    </html>
  );
}
