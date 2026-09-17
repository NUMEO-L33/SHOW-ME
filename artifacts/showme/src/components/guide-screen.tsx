import {
  ArrowDownLeft,
  ArrowLeft,
  ArrowUpRight,
  Bell,
  Building2,
  Check,
  ChevronDown,
  CircleUserRound,
  CreditCard,
  MoreHorizontal,
  Search,
  Send,
  WalletCards,
} from "lucide-react";

import type { GuideStep } from "@/lib/showme-data";

type GuideScreenProps = {
  step: GuideStep;
  compact?: boolean;
  showTarget?: boolean;
  className?: string;
  onFrameError?: () => void;
};

function PrivacyMask({ className = "" }: { className?: string }) {
  return (
    <span
      className={`privacy-mask inline-flex min-w-[76px] items-center justify-center rounded-[5px] px-2 py-0.5 font-black text-[#67508f] ${className}`}
      aria-label="가려진 개인정보"
    >
      ········
    </span>
  );
}

function TopBar() {
  return (
    <div className="flex items-center justify-between px-[7%] pb-[2%] pt-[4%] text-[8px] font-black text-[#20283b] sm:text-[10px]">
      <span>9:41</span>
      <div className="flex items-center gap-1">
        <span className="h-[5px] w-[9px] rounded-sm bg-[#20283b]" />
        <span className="h-[6px] w-[9px] rounded-[2px] border border-[#20283b]"><span className="block h-full w-[70%] bg-[#20283b]" /></span>
      </div>
    </div>
  );
}

function AppHeader({ back = false, title }: { back?: boolean; title: string }) {
  return (
    <div className="flex items-center justify-between px-[6%] py-[4%]">
      {back ? <ArrowLeft className="size-[5%] min-h-4 min-w-4 text-[#172033]" /> : <span className="text-[clamp(12px,4.5cqw,22px)] font-black tracking-[-0.06em] text-[#172033]">haeun</span>}
      <span className="absolute left-1/2 -translate-x-1/2 text-[clamp(10px,3.7cqw,16px)] font-black text-[#172033]">{title}</span>
      {back ? <MoreHorizontal className="size-[5%] min-h-4 min-w-4 text-[#6c758a]" /> : <Bell className="size-[5%] min-h-4 min-w-4 text-[#6c758a]" />}
    </div>
  );
}

function HomeScreen({ masked }: { masked: boolean }) {
  return (
    <>
      <AppHeader title="" />
      <div className="px-[6%] pt-[2%]">
        <div className="rounded-[7%] bg-[#263656] px-[8%] py-[8%] text-white shadow-[0_14px_30px_rgba(19,31,56,.22)]">
          <div className="flex items-start justify-between">
            <div>
              <p className="text-[clamp(7px,2.8cqw,12px)] font-bold text-white/60">입출금 계좌</p>
              <p className="mt-[8%] text-[clamp(13px,5cqw,24px)] font-black tracking-[-0.04em]">2,480,500원</p>
            </div>
            <ChevronDown className="size-[8%] min-h-4 min-w-4 text-white/60" />
          </div>
          <div className="mt-[10%] flex items-center justify-between text-[clamp(6px,2.5cqw,11px)] font-semibold text-white/65">
            {masked ? <PrivacyMask className="bg-white/90 !text-[#63547b]" /> : <span>하나 110-492-083771</span>}
            <span>계좌관리</span>
          </div>
        </div>

        <div className="mt-[7%] grid grid-cols-4 gap-[3%] text-center">
          {[
            { icon: Send, label: "이체", accent: true },
            { icon: ArrowDownLeft, label: "받기" },
            { icon: CreditCard, label: "카드" },
            { icon: MoreHorizontal, label: "전체" },
          ].map(({ icon: Icon, label, accent }) => (
            <div key={label} className="flex flex-col items-center gap-1.5">
              <span className={`grid aspect-square w-[76%] place-items-center rounded-[35%] ${accent ? "bg-[#ff7158] text-white" : "bg-[#f0f2f7] text-[#59647a]"}`}>
                <Icon className="size-[42%]" strokeWidth={2.2} />
              </span>
              <span className="text-[clamp(6px,2.5cqw,11px)] font-bold text-[#39445c]">{label}</span>
            </div>
          ))}
        </div>

        <div className="mt-[9%]">
          <div className="mb-[4%] flex items-center justify-between">
            <p className="text-[clamp(9px,3.5cqw,15px)] font-black text-[#172033]">최근 내역</p>
            <span className="text-[clamp(6px,2.4cqw,10px)] font-bold text-[#71809b]">전체보기</span>
          </div>
          {["편의점", "김하늘", "교통카드"].map((name, index) => (
            <div key={name} className="flex items-center gap-[4%] border-b border-[#edf0f5] py-[4%]">
              <span className="grid aspect-square w-[13%] place-items-center rounded-full bg-[#eef1f7] text-[#64708a]">
                {index === 1 ? <ArrowDownLeft className="size-[45%]" /> : <ArrowUpRight className="size-[45%]" />}
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-[clamp(7px,2.7cqw,12px)] font-extrabold text-[#2a3449]">{name}</p>
                <p className="mt-0.5 text-[clamp(5px,2.1cqw,9px)] font-semibold text-[#8b94a7]">오늘</p>
              </div>
              <span className="text-[clamp(7px,2.7cqw,12px)] font-black text-[#303a50]">{index === 1 ? "+50,000" : `-${(index + 1) * 4700}`}원</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function AccountScreen({ masked }: { masked: boolean }) {
  return (
    <>
      <AppHeader back title="출금 계좌" />
      <div className="px-[6%] pt-[5%]">
        <p className="text-[clamp(12px,4.8cqw,22px)] font-black leading-tight tracking-[-0.04em] text-[#172033]">어느 계좌에서<br />보낼까요?</p>
        <div className="mt-[8%] rounded-[6%] border-2 border-[#ff7158] bg-[#fffafa] p-[6%] shadow-[0_10px_24px_rgba(255,105,78,.1)]">
          <div className="flex items-center gap-[5%]">
            <span className="grid aspect-square w-[17%] place-items-center rounded-[32%] bg-[#263656] text-white">
              <WalletCards className="size-[50%]" />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1">
                <p className="text-[clamp(8px,3cqw,13px)] font-black text-[#303a50]">하나 주거래 통장</p>
                <span className="rounded-full bg-[#ffe6e1] px-1.5 py-0.5 text-[clamp(5px,2cqw,8px)] font-black text-[#d94d34]">주계좌</span>
              </div>
              <div className="mt-[4%] text-[clamp(6px,2.5cqw,10px)] font-semibold text-[#7c869b]">
                {masked ? <PrivacyMask /> : "110-492-083771"}
              </div>
            </div>
            <span className="grid size-[8%] min-h-4 min-w-4 place-items-center rounded-full bg-[#ff7158] text-white"><Check className="size-[65%]" strokeWidth={3} /></span>
          </div>
          <p className="mt-[6%] border-t border-[#f1d9d5] pt-[5%] text-right text-[clamp(9px,3.4cqw,15px)] font-black text-[#202a40]">2,480,500원</p>
        </div>
        <div className="mt-[5%] rounded-[6%] border border-[#e5e8ef] bg-white p-[6%] opacity-75">
          <div className="flex items-center gap-[5%]">
            <span className="grid aspect-square w-[17%] place-items-center rounded-[32%] bg-[#e9edfa] text-[#5069c8]"><CreditCard className="size-[48%]" /></span>
            <div className="flex-1">
              <p className="text-[clamp(8px,3cqw,13px)] font-black text-[#303a50]">생활비 통장</p>
              <p className="mt-1 text-[clamp(6px,2.3cqw,10px)] font-semibold text-[#8a94a8]">잔액 380,000원</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

function RecipientScreen({ masked }: { masked: boolean }) {
  return (
    <>
      <AppHeader back title="받는 분" />
      <div className="px-[6%] pt-[4%]">
        <p className="text-[clamp(12px,4.8cqw,22px)] font-black leading-tight tracking-[-0.04em] text-[#172033]">누구에게<br />보낼까요?</p>
        <div className="mt-[7%] flex h-[12%] items-center gap-[4%] rounded-[5%] bg-[#f0f2f7] px-[5%] text-[#758097]">
          <Search className="size-[6%] min-h-4 min-w-4" />
          <span className="text-[clamp(7px,2.7cqw,11px)] font-bold">이름 또는 계좌번호 찾기</span>
        </div>
        <p className="mb-[4%] mt-[8%] text-[clamp(8px,3cqw,13px)] font-black text-[#303a50]">최근 보낸 분</p>
        {["김하늘", "박선영", "이정호"].map((name, index) => (
          <div key={name} className="flex items-center gap-[4%] border-b border-[#edf0f5] py-[4%]">
            <span className={`grid aspect-square w-[14%] place-items-center rounded-full ${index === 0 ? "bg-[#ffebe7] text-[#df583f]" : "bg-[#eef1f7] text-[#68738a]"}`}><CircleUserRound className="size-[52%]" /></span>
            <div className="flex-1">
              <p className="text-[clamp(8px,2.9cqw,12px)] font-black text-[#303a50]">{name}</p>
              <p className="mt-0.5 text-[clamp(5px,2.2cqw,9px)] font-semibold text-[#8b94a7]">{index === 0 && masked ? <PrivacyMask /> : `하나 ${index + 1}10-***-12${index}456`}</p>
            </div>
          </div>
        ))}
        <div className="absolute inset-x-[6%] bottom-[5%] rounded-[5%] bg-[#ff7158] py-[5%] text-center text-[clamp(8px,3.2cqw,13px)] font-black text-white shadow-[0_10px_24px_rgba(255,105,78,.25)]">새 계좌번호 입력하기</div>
      </div>
    </>
  );
}

function AmountScreen() {
  return (
    <>
      <AppHeader back title="보낼 금액" />
      <div className="px-[6%] pt-[5%]">
        <p className="text-[clamp(7px,2.8cqw,11px)] font-bold text-[#7b8599]">김하늘 님에게</p>
        <div className="mt-[3%] flex items-end justify-between border-b-2 border-[#ff7158] pb-[4%]">
          <p className="text-[clamp(18px,7.2cqw,32px)] font-black tracking-[-0.05em] text-[#172033]">50,000<span className="ml-1 text-[45%]">원</span></p>
          <span className="mb-1 rounded-full bg-[#eaf6f1] px-2 py-1 text-[clamp(5px,2.1cqw,9px)] font-black text-[#257a61]">송금 가능</span>
        </div>
        <div className="mt-[5%] grid grid-cols-4 gap-[2%]">
          {["+1만", "+5만", "+10만", "전액"].map((amount) => <span key={amount} className="rounded-[20%] bg-[#f0f2f7] py-[16%] text-center text-[clamp(6px,2.3cqw,10px)] font-black text-[#5c687e]">{amount}</span>)}
        </div>
        <div className="mt-[9%] grid grid-cols-3 gap-y-[12%] text-center text-[clamp(14px,5.5cqw,24px)] font-black text-[#273149]">
          {[1,2,3,4,5,6,7,8,9,"00",0,"⌫"].map((number) => <span key={number}>{number}</span>)}
        </div>
        <div className="absolute inset-x-[6%] bottom-[4%] rounded-[5%] bg-[#ff7158] py-[5%] text-center text-[clamp(8px,3.2cqw,13px)] font-black text-white shadow-[0_10px_24px_rgba(255,105,78,.25)]">다음</div>
      </div>
    </>
  );
}

function ConfirmScreen({ masked }: { masked: boolean }) {
  return (
    <>
      <AppHeader back title="이체 확인" />
      <div className="px-[6%] pt-[5%]">
        <div className="mx-auto grid aspect-square w-[22%] place-items-center rounded-full bg-[#eaf6f1] text-[#287b62]"><Check className="size-[50%]" strokeWidth={3} /></div>
        <p className="mt-[5%] text-center text-[clamp(12px,4.8cqw,22px)] font-black leading-tight text-[#172033]">이대로 보내면<br />맞나요?</p>
        <div className="mt-[8%] rounded-[7%] bg-[#f4f6fa] p-[7%]">
          <div className="flex items-center justify-between border-b border-[#e0e4ec] pb-[5%]">
            <span className="text-[clamp(6px,2.4cqw,10px)] font-bold text-[#7f899d]">받는 분</span>
            <span className="text-[clamp(9px,3.4cqw,15px)] font-black text-[#263047]">김하늘</span>
          </div>
          <div className="flex items-center justify-between border-b border-[#e0e4ec] py-[5%]">
            <span className="text-[clamp(6px,2.4cqw,10px)] font-bold text-[#7f899d]">계좌</span>
            <span className="text-[clamp(7px,2.8cqw,12px)] font-black text-[#263047]">{masked ? <PrivacyMask /> : "하나 110-***-123456"}</span>
          </div>
          <div className="flex items-center justify-between pt-[5%]">
            <span className="text-[clamp(6px,2.4cqw,10px)] font-bold text-[#7f899d]">보낼 금액</span>
            <span className="text-[clamp(11px,4.2cqw,19px)] font-black text-[#263047]">50,000원</span>
          </div>
        </div>
        <div className="mt-[5%] flex items-center gap-[3%] rounded-[5%] border border-[#dfe3ec] p-[4%]">
          <Building2 className="size-[6%] min-h-4 min-w-4 text-[#6b7690]" />
          <span className="text-[clamp(6px,2.4cqw,10px)] font-bold text-[#69748a]">받는 분 통장에는 ‘홍길동’으로 표시돼요</span>
        </div>
        <div className="absolute inset-x-[6%] bottom-[4%] rounded-[5%] bg-[#ff7158] py-[5%] text-center text-[clamp(8px,3.2cqw,13px)] font-black text-white shadow-[0_10px_24px_rgba(255,105,78,.25)]">이체하기</div>
      </div>
    </>
  );
}

export function GuideScreen({ step, compact = false, showTarget = true, className = "", onFrameError }: GuideScreenProps) {
  const masked = step.privacyCount > 0 && step.privacyEnabled;
  const frameSource = compact ? step.thumbnailUrl ?? step.frameUrl : step.frameUrl;
  const hasFrame = Boolean(frameSource);
  const frameAspect = step.frameWidth && step.frameHeight
    ? `${step.frameWidth} / ${step.frameHeight}`
    : "9 / 19.5";

  return (
    <div
      className={`relative w-full overflow-hidden bg-white text-[#172033] [container-type:inline-size] ${compact ? "rounded-[8%]" : "rounded-[8%] shadow-[0_24px_70px_rgba(4,9,22,.28)]"} ${className}`}
      style={{ aspectRatio: frameAspect }}
      role="img"
      aria-label={`${step.shortLabel} 화면 예시`}
    >
      {hasFrame ? (
        // The URL is an authenticated derived frame, never the original video.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={frameSource} alt="" className="size-full object-contain" draggable={false} onError={onFrameError} />
      ) : (
        <>
          <TopBar />
          {step.screen === "home" && <HomeScreen masked={masked} />}
          {step.screen === "account" && <AccountScreen masked={masked} />}
          {step.screen === "recipient" && <RecipientScreen masked={masked} />}
          {step.screen === "amount" && <AmountScreen />}
          {step.screen === "confirm" && <ConfirmScreen masked={masked} />}
        </>
      )}
      {showTarget && step.targetVisible !== false && (
        <span
          aria-hidden="true"
          className="tap-marker absolute z-20 -translate-x-1/2 -translate-y-1/2"
          style={{ left: `${step.target.x}%`, top: `${step.target.y}%` }}
        >
          <span />
        </span>
      )}
    </div>
  );
}
