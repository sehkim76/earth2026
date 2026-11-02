"use client";

import { useRouter } from "next/navigation";
import QRScanner from "../../components/QRScanner";

export default function QRPage() {
  const router = useRouter();

  return (
    <div className="fixed inset-0">
      <QRScanner
        onScan={(decodedText) => {
          console.log("decoded:", decodedText);

          const appendFromParam = (target: string) => {
            try {
              const parsed = target.startsWith("http")
                ? new URL(target)
                : new URL(target, window.location.origin);

              if (!parsed.pathname.startsWith("/quiz/")) {
                return target;
              }

              if (!parsed.searchParams.has("from")) {
                parsed.searchParams.set("from", "qr");
              }

              if (target.startsWith("http")) {
                return parsed.toString();
              }

              return `${parsed.pathname}${parsed.search}${parsed.hash}`;
            } catch {
              return target;
            }
          };

          if (decodedText.startsWith("http")) {
            window.location.href = appendFromParam(decodedText);
            return;
          }

          if (decodedText.startsWith("/quiz/")) {
            router.push(appendFromParam(decodedText));
            return;
          }

          router.push(`/qr/result?value=${encodeURIComponent(decodedText)}`);
        }}
        autoStart={true}
        facingMode="environment"
        fps={12}
        overlaySize={180}
        cooldownMs={1500}
        vibrateOnScan
        beepOnScan
        stopOnScan={false}
      />
    </div>
  );
}
