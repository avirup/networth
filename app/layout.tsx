import type { Metadata } from "next";
import localFont from "next/font/local";
import { PRODUCT_NAME } from "@/lib/presentation/product";
import "./globals.css";
const poppins = localFont({
  src: [
    { path: "../public/fonts/Poppins-Regular.ttf", weight: "400", style: "normal" },
    { path: "../public/fonts/Poppins-Medium.ttf", weight: "500", style: "normal" },
    { path: "../public/fonts/Poppins-SemiBold.ttf", weight: "600", style: "normal" },
    { path: "../public/fonts/Poppins-Bold.ttf", weight: "700", style: "normal" },
  ], variable: "--font-poppins", display: "swap", preload: true,
});

export const metadata: Metadata = {
  title: PRODUCT_NAME,
  description: "Your private household finance tracker.",
  robots: { index: false, follow: false },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en-IN" className={poppins.variable}><body>{children}</body></html>;
}
