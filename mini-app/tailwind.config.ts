import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ["class"],
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      borderRadius: {
        xl: "1rem",
        "2xl": "1.25rem",
      },
      colors: {
        background: "hsl(222 47% 5%)",
        foreground: "hsl(210 40% 98%)",
        muted: "hsl(217 33% 18%)",
        "muted-foreground": "hsl(215 20% 65%)",
        border: "hsl(217 33% 22%)",
        card: "hsl(222 47% 8%)",
        "card-foreground": "hsl(210 40% 98%)",
        primary: "hsl(199 89% 48%)",
        "primary-foreground": "hsl(222 47% 5%)",
        destructive: "hsl(0 72% 51%)",
        "destructive-foreground": "hsl(210 40% 98%)",
        success: "hsl(142 76% 36%)",
        warning: "hsl(38 92% 50%)",
      },
    },
  },
  plugins: [],
};

export default config;
