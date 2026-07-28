import { ImageResponse } from "next/og";

// PWA MASKABLE icon 512×512. The monogram sits inside the ~80% safe zone so Android's
// adaptive-icon mask (circle/squircle) never clips it; the navy field bleeds to the edges.
export const runtime = "nodejs";

export function GET() {
  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", alignItems: "center", justifyContent: "center", background: "#0F172A" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", fontFamily: "Arial, sans-serif", fontSize: 230, fontWeight: 800, letterSpacing: -12, lineHeight: 1 }}>
          <span style={{ color: "#FFFFFF" }}>C</span>
          <span style={{ color: "#2563EB" }}>O</span>
        </div>
      </div>
    ),
    { width: 512, height: 512 },
  );
}
