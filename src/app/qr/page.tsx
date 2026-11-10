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

          const appendFromParam = (target: string) => target;

          if (decodedText.startsWith("http")) {
            window.location.href = decodedText;
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
