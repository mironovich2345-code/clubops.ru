import type { Metadata, Viewport } from "next";
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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="ru">
      <body>{children}</body>
    </html>
  );
}
