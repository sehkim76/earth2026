"use client";

import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";

import ArImageTargetMode from "@/components/ArImageTargetMode";

type CameraPermissionStatus = "prompting" | "granted" | "denied";

type PreStudySide = "TOP" | "BOTTOM" | "LEFT" | "RIGHT" | "FRONT" | "BACK";
type ArQrPhase = "imageAr" | "video" | "cards";

const SIDE_LIST: PreStudySide[] = ["TOP", "BOTTOM", "LEFT", "RIGHT", "FRONT", "BACK"];
const FALLBACK_IMAGE = "/arqr-assets/Images/EDBOX_shadow.png";

const SIDE_LABEL: Record<PreStudySide, string> = {
  TOP: "TOP",
  BOTTOM: "BOTTOM",
  LEFT: "LEFT",
  RIGHT: "RIGHT",
  FRONT: "FRONT",
  BACK: "BACK",
};

const buildAssetUrl = (...segments: string[]) => {
  return `/arqr-assets/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
};

const detectSideFromScan = (decodedText: string): PreStudySide | null => {
  const upper = decodedText.trim().toUpperCase();
  const match = upper.match(/(^|[^A-Z])(TOP|BOTTOM|LEFT|RIGHT|FRONT|BACK)($|[^A-Z])/);
  if (!match) {
    return null;
  }

  const candidate = match[2] as PreStudySide;
  return SIDE_LIST.includes(candidate) ? candidate : null;
};

const PreStudyFlipCard = ({
  side,
  index,
  opened,
  onToggle,
}: {
  side: PreStudySide;
  index: number;
  opened: boolean;
  onToggle: () => void;
}) => {
  const frontSrc = buildAssetUrl("Resources", "JobCard", `category_${side}`, `${index}-0.png`);
  const backSrc = buildAssetUrl("Resources", "JobCard", `category_${side}`, `${index}-1.png`);

  return (
    <button
      type="button"
      onClick={onToggle}
      className="group relative h-[320px] w-[220px] shrink-0 overflow-hidden rounded-3xl border border-white/20 bg-white/10 text-left shadow-[0_22px_50px_rgba(0,0,0,0.35)] backdrop-blur"
      style={{ perspective: 1200 }}
    >
      <div
        className="relative h-full w-full transition-transform duration-500"
        style={{
          transformStyle: "preserve-3d",
          transform: opened ? "rotateY(180deg)" : "rotateY(0deg)",
        }}
      >
        <div
          className="absolute inset-0 flex flex-col"
          style={{
            backfaceVisibility: "hidden",
          }}
        >
          <img
            src={frontSrc}
            alt={`${side} card ${index} front`}
            className="h-[66%] w-full object-cover"
            onError={(event) => {
              event.currentTarget.src = FALLBACK_IMAGE;
            }}
          />
          <div className="flex h-[34%] flex-col justify-between p-4 text-white">
            <div>
              <p className="text-xs font-bold tracking-[0.18em] text-cyan-200">PRE-STUDY</p>
              <p className="mt-1 text-lg font-bold">{SIDE_LABEL[side]} 카드 {index}</p>
            </div>
            <p className="text-xs text-white/80">탭해서 카드 뒷면 보기</p>
          </div>
        </div>

        <div
          className="absolute inset-0"
          style={{
            transform: "rotateY(180deg)",
            backfaceVisibility: "hidden",
          }}
        >
          <img
            src={backSrc}
            alt={`${side} card ${index} back`}
            className="h-full w-full object-cover"
            onError={(event) => {
              event.currentTarget.src = frontSrc;
            }}
          />
        </div>
      </div>
    </button>
  );
};

export default function ARQRPage() {
  const router = useRouter();

  const [cameraPermission, setCameraPermission] = useState<CameraPermissionStatus>("prompting");
  const [phase, setPhase] = useState<ArQrPhase>("imageAr");
  const [activeSide, setActiveSide] = useState<PreStudySide | null>(null);
  const [openCardIndex, setOpenCardIndex] = useState<number | null>(null);
  const [lastDecodedText, setLastDecodedText] = useState("");

  const requestCameraPermission = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ video: true });
      stream.getTracks().forEach((track) => {
        track.stop();
      });
      setCameraPermission("granted");
    } catch {
      setCameraPermission("denied");
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const req = async () => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        if (cancelled) return;
        stream.getTracks().forEach((t) => {
          t.stop();
        });
        setCameraPermission("granted");
      } catch {
        if (cancelled) return;
        setCameraPermission("denied");
      }
    };
    req();
    return () => {
      cancelled = true;
    };
  }, []);

  const videoSrc = useMemo(() => {
    if (!activeSide) {
      return "";
    }

    return buildAssetUrl("QubeMovieBackUp", `category_${activeSide}.mp4`);
  }, [activeSide]);

  return (
    <main className="relative h-screen w-screen overflow-hidden bg-[radial-gradient(circle_at_top,_#103047_0%,_#050c12_55%,_#020406_100%)] text-white">
      {cameraPermission !== "granted" ? (
        <div className="flex w-full h-full flex-col items-center justify-center gap-6 px-4 text-center">
          <div className="flex h-20 w-20 items-center justify-center rounded-full border-4 border-cyan-200/40 bg-cyan-500/20">
            <svg className="h-10 w-10 text-cyan-200" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
              <circle cx="12" cy="13" r="4" />
            </svg>
          </div>
          <div className="space-y-2">
            <h1 className="text-xl font-bold text-white">카메라 권한 필요</h1>
            <p className="text-sm text-white/70">AR 기능을 사용하려면 카메라 접근 권한이 필요합니다.</p>
          </div>
          {cameraPermission === "denied" ? (
            <div className="space-y-3">
              <p className="text-sm text-red-300">카메라 권한이 거부되었습니다.</p>
              <p className="text-xs text-white/50">브라우저 설정에서 카메라 권한을 허용해주세요.</p>
              <button
                type="button"
                onClick={() => setCameraPermission("prompting")}
                className="rounded-lg bg-cyan-500 px-6 py-2 text-sm font-semibold text-white transition hover:bg-cyan-400"
              >
                다시 시도
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={requestCameraPermission}
              className="rounded-lg bg-cyan-500 px-6 py-2 text-sm font-semibold text-white transition hover:bg-cyan-400"
            >
              권한 허용
            </button>
          )}
        </div>
      ) : cameraPermission === "granted" && phase === "imageAr" ? (
        <ArImageTargetMode
          onExitToMap={() => router.push("/map")}
          onQRDetected={(decodedText) => {
            console.log("[QR] Detected in Image AR mode:", decodedText);
            setLastDecodedText(decodedText);
            
            const side = detectSideFromScan(decodedText);
            if (side) {
              setActiveSide(side);
              setOpenCardIndex(null);
              setPhase("video");
              return;
            }
            
            if (decodedText.startsWith("http")) {
              window.location.href = decodedText;
              return;
            }

            if (decodedText.startsWith("/quiz/")) {
              router.push(decodedText);
              return;
            }

            router.push(`/event?eventkey=${encodeURIComponent(decodedText)}&host=web&exitUrl=/arqr`);
          }}
        />
      ) : phase === "video" && activeSide && (
        <section className="relative flex h-full w-full flex-col">
          <header className="z-10 flex items-center justify-between p-4">
            <button
              type="button"
              onClick={() => setPhase("imageAr")}
              className="rounded-full bg-black/50 px-4 py-2 text-xs font-bold tracking-wide"
            >
              다시 스캔
            </button>
            <p className="text-sm font-black tracking-[0.18em] text-cyan-200">CATEGORY_{activeSide}</p>
            <button
              type="button"
              onClick={() => setPhase("cards")}
              className="rounded-full bg-black/50 px-4 py-2 text-xs font-bold tracking-wide"
            >
              카드 보기
            </button>
          </header>

          <div className="relative flex-1 p-4 pt-0">
            <div className="h-full w-full overflow-hidden rounded-3xl border border-white/20 bg-black/60 shadow-[0_24px_48px_rgba(0,0,0,0.45)]">
              <video
                key={videoSrc}
                src={videoSrc}
                className="h-full w-full object-cover"
                controls
                autoPlay
                playsInline
                onEnded={() => setPhase("cards")}
              >
                <track kind="captions" srcLang="ko" label="Korean captions" />
              </video>
            </div>
          </div>
        </section>
      )}

      {phase === "cards" && activeSide && (
        <section className="flex h-full w-full flex-col p-4">
          <header className="mb-3 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setPhase("imageAr")}
              className="rounded-full bg-black/45 px-4 py-2 text-xs font-bold tracking-wide"
            >
              스캔 화면
            </button>
            <p className="text-sm font-black tracking-[0.16em] text-cyan-200">{SIDE_LABEL[activeSide]} PRE-STUDY CARDS</p>
            <button
              type="button"
              onClick={() => setPhase("video")}
              className="rounded-full bg-black/45 px-4 py-2 text-xs font-bold tracking-wide"
            >
              영상 다시보기
            </button>
          </header>

          <div className="flex-1 overflow-x-auto overflow-y-hidden rounded-3xl border border-white/15 bg-black/35 px-4 py-5">
            <div className="flex min-h-full items-center gap-4">
              {[1, 2, 3, 4, 5].map((index) => (
                <PreStudyFlipCard
                  key={index}
                  side={activeSide}
                  index={index}
                  opened={openCardIndex === index}
                  onToggle={() => {
                    setOpenCardIndex((prev) => (prev === index ? null : index));
                  }}
                />
              ))}
            </div>
          </div>
        </section>
      )}
    </main>
  );
}
