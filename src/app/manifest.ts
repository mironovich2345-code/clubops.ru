import type { MetadataRoute } from "next";

// Web App Manifest (App Router) → served at /manifest.webmanifest and auto-linked in <head>.
// Makes CLUB-OPS installable / standalone. Icons are generated on the fly (ImageResponse)
// at /pwa/icon-192, /pwa/icon-512, /pwa/icon-maskable — no font files, no bundled binaries.
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "CLUB-OPS",
    short_name: "Club Ops",
    description: "Операционная система управления сетью фитнес-клубов",
    start_url: "/",
    scope: "/",
    display: "standalone",
    background_color: "#0b1220",
    theme_color: "#0b1220",
    orientation: "portrait-primary",
    lang: "ru",
    dir: "ltr",
    categories: ["business", "finance", "productivity"],
    icons: [
      { src: "/pwa/icon-192", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-512", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/pwa/icon-maskable", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      { name: "Расходы", short_name: "Расходы", url: "/expenses" },
      { name: "Счета", short_name: "Счета", url: "/invoices" },
      { name: "Зарплата", short_name: "ФОТ", url: "/payroll" },
    ],
  };
}
