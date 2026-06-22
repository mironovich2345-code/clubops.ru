import { ImageResponse } from "next/og";

// CLUB-OPS favicon (App Router special file → served at /icon). Dark navy field,
// white "C" + blue "O" monogram. High contrast, no gradients/thin details, stays
// legible at 16×16 in both light and dark browser chrome.
export const size = { width: 32, height: 32 };
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          background: "#0F172A",
          fontFamily: "Arial, sans-serif",
          fontSize: 21,
          fontWeight: 800,
          letterSpacing: -1,
          lineHeight: 1,
        }}
      >
        <span style={{ color: "#FFFFFF" }}>C</span>
        <span style={{ color: "#2563EB" }}>O</span>
      </div>
    ),
    { ...size },
  );
}
