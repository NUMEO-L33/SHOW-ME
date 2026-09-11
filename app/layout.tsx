import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ShowMe — 화면 녹화로 만드는 따라 하기 가이드",
  description: "화면 녹화를 올리면 AI가 단계별 안내 링크로 정리합니다.",
  icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body className="antialiased">{children}</body>
    </html>
  );
}
