import localFont from "next/font/local";

/**
 * The brand's display face: Geist 500/600. It sets the wordmark everywhere
 * (sidebar, login), so the root layout puts its variable on <html>. The
 * variable keeps its original name (--font-landing-display) because the
 * stylesheets refer to it.
 *
 * The files ship with the app (from Vercel's `geist` package, OFL) instead of
 * coming from Google Fonts: on the build server Google's Geist URLs broke
 * Turbopack's font loader ("next/font/google queries have exactly one entry"),
 * failing the whole deploy.
 */
export const brandDisplay = localFont({
  src: [
    { path: "./fonts/Geist-Medium.woff2", weight: "500", style: "normal" },
    { path: "./fonts/Geist-SemiBold.woff2", weight: "600", style: "normal" },
  ],
  variable: "--font-landing-display",
  display: "swap",
});

/** Tailwind classes for text in the display face. */
export const brandDisplayClass = "font-[family-name:var(--font-landing-display)] font-medium";
