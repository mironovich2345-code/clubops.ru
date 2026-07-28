import { ImageResponse } from "next/og";

// PWA icon 512×512 (purpose: any).
export const runtime = "nodejs";
export const contentType = "image/png";

export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A", fontFamily: "Arial, sans-serif", fontSize: 315, fontWeight: 800, letterSpacing: -16, lineHeight: 1 }}>
        <span style={{ color: "#FFFFFF" }}>C</span>
        <span style={{ color: "#2563EB" }}>O</span>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
