import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "SONIVOX Live — Voice AI",
  description: "A voice-first AI conversation test powered by OpenRouter and Sonivox speech.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
