import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getAppUrlSafe } from "@/lib/app-url";
import { PwaBoot } from "@/components/pwa/PwaBoot";
import "./globals.css";

// Runtime-resolved so metadataBase reflects the deployment's APP_URL
// (https://pilot.clubops.ru in production) without baking a value at build time.
// Icons are provided by the App Router special files (icon.tsx / apple-icon.tsx)
// and auto-injected — no manual <link> declarations needed.
export function generateMetadata(): Metadata {
  const appUrl = getAppUrlSafe();
  return {
    ...(appUrl ? { metadataBase: new URL(appUrl) } : {}),
    applicationName: "CLUB-OPS",
    title: {
      default: "CLUB-OPS",
      template: "%s · CLUB-OPS",
    },
    description: "Операционная система управления сетью фитнес-клубов",
    // The web app manifest link is auto-injected by App Router src/app/manifest.ts.
    appleWebApp: {
      capable: true,
      title: "CLUB-OPS",
      // Transparent status bar so our safe-area padding controls the notch area.
      statusBarStyle: "black-translucent",
    },
    formatDetection: { telephone: false },
  };
}

// viewport-fit=cover exposes env(safe-area-inset-*) under the notch / home indicator.
// initialScale=1 without user-scalable=no (accessibility zoom stays enabled; iOS focus
// auto-zoom is prevented by the ≥16px input font-size in globals.css, not by locking scale).
// Per-scheme theme-color so the status bar matches light/dark.
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f8fafc" },
    { media: "(prefers-color-scheme: dark)", color: "#0b1220" },
  ],
};

// Runs before paint (no framework, no imports) so the saved theme is applied before
// React hydrates — prevents a light→dark flash. Reads localStorage("theme") =
// light | dark | system (default system → follows the OS). Never touches auth/session.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('theme')||'system';var m=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=t==='dark'||(t==='system'&&m);var e=document.documentElement;e.classList.toggle('dark',d);e.setAttribute('data-theme',d?'dark':'light');e.style.colorScheme=d?'dark':'light';}catch(e){}})();`;

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  // Per-request CSP nonce (set by src/middleware.ts). Applying it to the static
  // theme-init script lets us drop 'unsafe-inline' from script-src.
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <html lang="ru" suppressHydrationWarning>
      <head>
        <script nonce={nonce} dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        {children}
        <PwaBoot />
      </body>
    </html>
  );
}
