import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";

const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "Business API Repository",
  description:
    "Discover, compare and contribute business APIs for global e-invoicing integrations.",
  openGraph: {
    title: "Business API Repository",
    description: "Discover · Compare · Contribute",
    type: "website",
    images: [{ url: "/og.png", width: 1730, height: 909 }],
  },
  twitter: {
    card: "summary_large_image",
    title: "Business API Repository",
    description: "Discover · Compare · Contribute",
    images: ["/og.png"],
  },
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
