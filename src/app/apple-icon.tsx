import { ImageResponse } from "next/og";

// CLUB-OPS Apple touch icon (App Router special file → served at /apple-icon).
// 180×180 rounded-square for the iPhone home screen — same identity as /icon:
// navy field, white "C" + blue "O" monogram.
export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
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
          borderRadius: 40,
          fontFamily: "Arial, sans-serif",
          fontSize: 104,
          fontWeight: 800,
          letterSpacing: -4,
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
