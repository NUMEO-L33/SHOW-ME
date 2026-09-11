export type GuideStep = {
  id: number;
  shortLabel: string;
  instruction: string;
  screen: "home" | "account" | "recipient" | "amount" | "confirm";
  target: { x: number; y: number };
  privacyCount: number;
  privacyEnabled: boolean;
};

export const INITIAL_GUIDE_STEPS: GuideStep[] = [
  {
    id: 1,
    shortLabel: "이체 메뉴 열기",
    instruction: "홈 화면에서 ‘이체’ 버튼을 누르세요.",
    screen: "home",
    target: { x: 73, y: 36 },
    privacyCount: 1,
    privacyEnabled: true,
  },
  {
    id: 2,
    shortLabel: "출금 계좌 고르기",
    instruction: "돈을 보낼 계좌를 선택하세요.",
    screen: "account",
    target: { x: 50, y: 43 },
    privacyCount: 1,
    privacyEnabled: true,
  },
  {
    id: 3,
    shortLabel: "받는 분 입력하기",
    instruction: "받는 분의 은행과 계좌번호를 입력하세요.",
    screen: "recipient",
    target: { x: 50, y: 74 },
    privacyCount: 2,
    privacyEnabled: true,
  },
  {
    id: 4,
    shortLabel: "금액 입력하기",
    instruction: "보낼 금액을 입력한 뒤 ‘다음’을 누르세요.",
    screen: "amount",
    target: { x: 50, y: 86 },
    privacyCount: 0,
    privacyEnabled: true,
  },
  {
    id: 5,
    shortLabel: "내용 확인하기",
    instruction: "받는 분과 금액을 확인하고 ‘이체하기’를 누르세요.",
    screen: "confirm",
    target: { x: 50, y: 88 },
    privacyCount: 1,
    privacyEnabled: true,
  },
];

export const GUIDE_TITLE = "모바일뱅킹으로 계좌 이체하기";
