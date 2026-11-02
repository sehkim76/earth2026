"use client";

import React, { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Html5Qrcode } from "html5-qrcode";

import { cn } from "@/lib/utils";

type QRScannerProps = {
  title?: string;

  /** QR 스캔 성공 시 호출 */
  onScan: (decodedText: string) => void;

  /** 권한/디버그 에러 메시지 필요시 */
  onError?: (message: string) => void;

  /** 자동 시작 */
  autoStart?: boolean;

  /** 후면/전면 */
  facingMode?: "environment" | "user";

  /** fps 10~15 권장 */
  fps?: number;

  /** 오버레이 가이드 박스(px) */
  overlaySize?: number;

  /** 스캔 성공 후 stop 여부 */
  stopOnScan?: boolean;

  /** 중복 방지 ms */
  cooldownMs?: number;

  /** 성공 시 진동 */
  vibrateOnScan?: boolean;

  /** 성공 시 비프음 */
  beepOnScan?: boolean;

  className?: string;
};

/** (A) Beep Sound (WebAudio) */
function playBeep(durationMs = 120, freq = 880, volume = 0.06) {
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as Window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.value = volume;

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start();

    window.setTimeout(() => {
      osc.stop();
      ctx.close().catch(() => {});
    }, durationMs);
  } catch {
    // ignore
  }
}

export default function QRScanner({
  title = "QR 코드 스캔",
  onScan,
  onError,
  autoStart = true,
  facingMode = "environment",
  fps = 12,
  overlaySize = 160,
  stopOnScan = false,
  cooldownMs = 1500,
  vibrateOnScan = true,
  beepOnScan = true,
  className,
}: QRScannerProps) {
  const router = useRouter();

  /** ✅ hydration mismatch 방지: mount 이후 regionId 생성 */
  const [regionId, setRegionId] = useState<string | null>(null);

  const qrRef = useRef<Html5Qrcode | null>(null);
  const [isRunning, setIsRunning] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const scanOptionsRef = useRef({
    cooldownMs,
    beepOnScan,
    vibrateOnScan,
    stopOnScan,
    onScan,
  });

  /** (C) 중복 방지 */
  const lastScanAtRef = useRef<number>(0);
  const lastDecodedRef = useRef<string>("");

  /** mount 관리 */
  const isMountedRef = useRef(true);

  useEffect(() => {
    setRegionId(`qr-reader-${crypto.randomUUID()}`);
  }, []);

  useEffect(() => {
    scanOptionsRef.current = {
      cooldownMs,
      beepOnScan,
      vibrateOnScan,
      stopOnScan,
      onScan,
    };
  }, [beepOnScan, cooldownMs, onScan, stopOnScan, vibrateOnScan]);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  /** ✅ 카메라 권한 사전 요청 (warm-up) */
  const warmUpCameraPermission = useCallback(async () => {
    setPermissionError(null);

    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        throw new Error("이 브라우저는 카메라 접근을 지원하지 않습니다.");
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode },
        audio: false,
      });

      // 권한만 확보 후 즉시 종료 (html5-qrcode가 다시 점유)
      stream.getTracks().forEach((t) => t.stop());
    } catch (err: unknown) {
      let msg =
        "카메라 권한이 없거나 브라우저 설정에서 차단되어 있습니다.";
      if (err && typeof err === "object" && "message" in err && typeof (err as { message?: unknown }).message === "string") {
        msg = (err as { message: string }).message;
      }
      setPermissionError(msg);
      onError?.(msg);
      throw err;
    }
  }, [facingMode, onError]);

  const stop = useCallback(async () => {
    const inst = qrRef.current;
    if (!inst) return;

    try {
      await inst.stop();
    } catch {}

    try {
      await inst.clear();
    } catch {}

    qrRef.current = null;
    if (isMountedRef.current) setIsRunning(false);
  }, []);

  const processDecodedText = useCallback(
    async (decodedText: string) => {
      const now = Date.now();
      const { cooldownMs: cooldown, vibrateOnScan: vibrate, beepOnScan: beep, onScan: latestOnScan, stopOnScan: shouldStop } =
        scanOptionsRef.current;

      if (
        decodedText === lastDecodedRef.current &&
        now - lastScanAtRef.current < cooldown
      ) {
        return;
      }

      if (now - lastScanAtRef.current < 250) {
        return;
      }

      lastScanAtRef.current = now;
      lastDecodedRef.current = decodedText;

      if (vibrate && "vibrate" in navigator) {
        try {
          navigator.vibrate(80);
        } catch {}
      }
      if (beep) playBeep(120, 880, 0.06);

      latestOnScan(decodedText);

      if (shouldStop) {
        await stop();
      }
    },
    [stop]
  );

  const start = useCallback(async () => {
    if (!regionId) return;
    if (isRunning) return;

    setPermissionError(null);

    try {
      // 1) 권한 warm-up
      await warmUpCameraPermission();

      // 2) 브라우저에서만 import
      const { Html5Qrcode } = await import("html5-qrcode");

      const html5QrCode = new Html5Qrcode(regionId);
      qrRef.current = html5QrCode;

      setIsRunning(true);

          await html5QrCode.start(
            { facingMode },
            {
              fps,
              qrbox: { width: 180, height: 180 },
            },
            async (decodedText) => {
              await processDecodedText(decodedText);
            },
            () => {
              // scan fail는 매우 흔함 -> 기본 ignore
            }
          );
    } catch {
      if (isMountedRef.current) setIsRunning(false);
    }
  }, [
    facingMode,
    fps,
    isRunning,
    overlaySize,
    processDecodedText,
    regionId,
    warmUpCameraPermission,
  ]);

  /** 언마운트 시 정리 */
  useEffect(() => {
    return () => {
      stop();
    };
  }, [stop]);

  /** autoStart */
  useEffect(() => {
    if (!autoStart) return;
    if (!regionId) return;
    start();
  }, [autoStart, regionId, start]);

  return (
    <section
      className={cn(
        "relative isolate h-screen w-screen overflow-hidden",
        className
      )}
      aria-label={title}
    >
      {regionId && (
        <style>{`
          #${regionId} .qr-shaded-region { display: none !important; }
          #${regionId} .qr-shaded-border { display: none !important; }
          #${regionId} .qr-shaded-region-barcode { display: none !important; }
          #${regionId} > div { display: none !important; }
        `}</style>
      )}
      
      <div className="absolute inset-0">
        {regionId && (
          <div 
            id={regionId} 
            className="h-full w-full [&_video]:!object-cover [&_video]:!w-full [&_video]:!h-full"
            style={{ background: "transparent" }}
          />
        )}
      </div>

      {/* scan overlay box with text */}
      {regionId && (
        <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
          <div
            className="relative"
            style={{ width: overlaySize + 20, height: overlaySize + 20 }}
          >
            {/* top-left corner */}
            <div className="absolute left-0 top-0 h-12 w-12 border-t-4 border-l-4 border-yellow-400" />
            {/* top-right corner */}
            <div className="absolute right-0 top-0 h-12 w-12 border-t-4 border-r-4 border-yellow-400" />
            {/* bottom-left corner */}
            <div className="absolute bottom-0 left-0 h-12 w-12 border-b-4 border-l-4 border-yellow-400" />
            {/* bottom-right corner */}
            <div className="absolute bottom-0 right-0 h-12 w-12 border-b-4 border-r-4 border-yellow-400" />

            {/* center text */}
            <div className="absolute inset-0 flex items-center justify-center">
              <span className="text-sm font-medium text-white drop-shadow-[0_1px_1px_rgba(0,0,0,0.8)]">
                마커나 QR코드를 스캔하세요
              </span>
            </div>
          </div>
        </div>
      )}

      {/* Back button */}
      <button
        type="button"
        onClick={() => router.push("/map")}
        className="absolute left-4 top-4 z-50 flex h-10 w-10 items-center justify-center rounded-full bg-white/20 text-white shadow-lg backdrop-blur active:opacity-80"
      >
        ←
      </button>

      {/* 2 buttons */}
      <div className="absolute bottom-8 right-6 z-50 flex flex-col gap-3">
        <button
          type="button"
          onClick={() => {
            processDecodedText("http://localhost:8798/event?host=web&exitUrl=/qr&eventkey=BUSANCITIZEN_BUTTERFLY");
          }}
          className="rounded-full border border-white/50 bg-black/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-lg backdrop-blur active:opacity-80"
        >
          나비
        </button>

        <button
          type="button"
          onClick={() => {
            processDecodedText("http://localhost:8798/event?host=web&exitUrl=/qr&eventkey=5c17a1c7-910d-4c4e-9b79-8b63e5e49ca4");
          }}
          className="rounded-full border border-white/50 bg-black/30 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-white shadow-lg backdrop-blur active:opacity-80"
        >
          퀴즈
        </button>
      </div>
    </section>
  );
}
