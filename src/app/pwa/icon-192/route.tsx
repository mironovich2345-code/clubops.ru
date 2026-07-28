import { ImageResponse } from "next/og";

// PWA icon 192×192 (purpose: any). Navy field, white "C" + blue "O" monogram — matches
// the favicon/apple-icon. Full-bleed square (letterbox handled by the OS for `any`).
export const runtime = "nodejs";
export const contentType = "image/png";

export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A", fontFamily: "Arial, sans-serif", fontSize: 118, fontWeight: 800, letterSpacing: -6, lineHeight: 1 }}>
        <span style={{ color: "#FFFFFF" }}>C</span>
        <span style={{ color: "#2563EB" }}>O</span>
      </div>
    ),
    { width: 192, height: 192 },
  );
}
