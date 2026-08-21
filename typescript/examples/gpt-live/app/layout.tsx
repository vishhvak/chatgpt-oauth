import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "gpt-live over ChatGPT OAuth",
  description: "Full-duplex voice with client-side delegation, on a ChatGPT subscription.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
