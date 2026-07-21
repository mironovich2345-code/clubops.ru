import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { getAppUrlSafe } from "@/lib/app-url";
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
    appleWebApp: {
      capable: true,
      title: "CLUB-OPS",
    },
  };
}

export const viewport: Viewport = {
  themeColor: "#0F172A",
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
      <body>{children}</body>
    </html>
  );
}
