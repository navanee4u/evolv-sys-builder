import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Anvil — Autonomous Hardware Architect",
  description:
    "Anvil turns robotic-system requirements into a verified hardware design spec by running a self-correcting loop.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
