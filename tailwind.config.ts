import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  // Class-gated dark mode: `dark:` utilities stay dormant until a `.dark` class
  // is added to an ancestor (no such class is rendered today, so nothing changes
  // visually). Keeps Analytics dark-theme ready without forcing a theme switch.
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        brand: {
          50: "#eff6ff",
          100: "#dbeafe",
          500: "#3b82f6",
          600: "#2563eb",
          700: "#1d4ed8",
        },
      },
    },
  },
  plugins: [],
};

export default config;
