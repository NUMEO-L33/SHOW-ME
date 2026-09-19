import React from "react";

/** Customer-facing disclosure: omit implementation branding, not data risks. */
export function AnalysisConsentNotice({ frameCount }: { frameCount: number }) {
  return <div className="space-y-3 text-sm leading-relaxed">
    <p>장면 설명을 만들기 위해 <strong>추출된 전체 화면{frameCount > 0 ? ` ${frameCount}장` : ""}을 외부 AI 처리업체 Google에 전송합니다.</strong> 원본 영상과 음성은 보내지 않습니다.</p>
    <p>편집에서 삭제하거나 합친 장면도 전송 대상에 포함됩니다. 화면에 표시한 가림은 아직 전송 이미지에 반영되지 않습니다.</p>
    <p className="rounded-lg bg-amber-50 p-3">현재 연결된 무료 처리 서비스는 보낸 화면과 생성 결과를 제품 개선에 이용하거나 사람이 검토할 수 있습니다. 개인·민감·기밀 정보가 있는 화면은 보내면 안 됩니다. <strong>현재는 승인된 합성 자료만 사용할 수 있습니다.</strong> <a className="underline" href="https://ai.google.dev/gemini-api/terms#unpaid-services" target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">Google 데이터 처리 조건</a></p>
    <p>취소해도 이미 전송된 데이터를 회수할 수는 없습니다. 결과는 자동으로 공개하거나 기존 편집에 덮어쓰지 않으며, 검토한 단계만 선택해 적용할 수 있습니다.</p>
    <details className="rounded-lg border p-3">
      <summary className="cursor-pointer font-medium">전송 항목·비용·취소 자세히 보기</summary>
      <div className="mt-3 space-y-3">
        <p>추출된 전체 원본 화면, 장면의 순서·시각·크기와 설명 생성에 필요한 지시문을 보냅니다. 사용량을 계산하는 단계에서도 화면이 전송됩니다. 현재 제목·제작 의도·직접 쓴 설명은 보내거나 분석에 적용하지 않습니다.</p>
        <p>무료 이용 조건과 사용량 한도를 확인하지 못하면 실행을 막으며, 유료로 자동 전환하지 않습니다. 영상 처리·보관을 포함한 서비스 전체가 무료라는 뜻은 아닙니다.</p>
        <p>취소를 요청해도 외부에서 이미 시작된 처리나 사용량 집계가 즉시 멈춘다고 보장할 수는 없습니다. 취소 완료 여부는 서버 응답으로 확인합니다.</p>
      </div>
    </details>
  </div>;
}
