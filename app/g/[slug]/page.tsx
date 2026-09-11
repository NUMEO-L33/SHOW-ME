import type { Metadata } from "next";

import { PublicGuide } from "@/components/public-guide";
import { GUIDE_TITLE } from "@/lib/showme-data";

export const metadata: Metadata = {
  title: `${GUIDE_TITLE} · ShowMe`,
  description: "큰 화면과 쉬운 설명을 한 단계씩 보며 따라 하세요.",
};

export default function SharedGuidePage() {
  return <PublicGuide />;
}
