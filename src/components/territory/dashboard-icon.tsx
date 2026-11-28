import type { ReactElement } from "react";

type Emblem = "scroll" | "gate" | "soldier" | "victory" | "chief" | "vassal" | "king";

/** Small painted emblems for the map HUD. Text alongside each emblem provides its name. */
export function DashboardIcon({ kind, size = 18 }: { kind: Emblem; size?: number }): ReactElement {
  let art: ReactElement;
  switch (kind) {
    case "scroll":
      art = <>
        <path d="M4 4h15v15H5z" fill="#ffe3a9" />
        <path d="M6 4v13m2-7 3-3 4 2m-6 4h4" fill="none" stroke="#9e7748" />
        <rect x="2" y="2" width="4" height="16" rx="2" fill="#e7b86c" />
        <path d="M5 17h15q3 4-1 5H7q-4-1-2-5Z" fill="#f4cd88" />
        <circle cx="16.5" cy="13" r="2" fill="#dc7764" />
      </>;
      break;
    case "gate":
      art = <>
        <path d="M4 13h16v8H4z" fill="#f4d5a3" />
        <path d="M9 21v-4a3 3 0 0 1 6 0v4" fill="#885546" />
        <path d="M5.5 9h13v5h-13z" fill="#e59c75" />
        <path d="M2 10q5 0 8-6h4q3 6 8 6-2 3-10 2-8 1-10-2Z" fill="#78b6aa" />
      </>;
      break;
    case "victory":
      art = <>
        <path d="m6 13-2 9 5-2 2 2 2-8m0 0 3 8 2-3 4 1-4-9" fill="#dc7764" />
        <circle cx="12" cy="10" r="8" fill="#f4c968" />
        <path d="m12 5 1.4 3 3.3.5-2.4 2.4.6 3.4-2.9-1.6-2.9 1.6.6-3.4-2.4-2.4 3.3-.5Z" fill="#fff1bb" stroke="#ac7739" strokeWidth="1" />
      </>;
      break;
    default:
      art = <>
        <path d="M4 13q0-7 8-7t8 7v2q0 7-8 7t-8-7Z" fill="#ffdaae" />
        <path d="M8.4 15v1m7.2-1v1" fill="none" strokeWidth="1.9" />
        <path d="M10.5 18q1.5 1.4 3 0" fill="none" strokeWidth="1" />
        {kind === "king" ? <path d="M4 12V7h3V3h10v4h3v5q-8-2-16 0Z" fill="#57576d" /> :
          kind === "vassal" ? <path d="M2 11h4l2-7h8l2 7h4q-8 4-20 0Z" fill="#729b9d" /> :
          kind === "soldier" ? <><path d="m4 11 3-7q5-3 10 0l3 7-8 2Z" fill="#83b6a7" /><path d="M12 6q-1-5 3-5l1 2-3 4" fill="#ef9579" /></> :
          <><path d="M4 9q8-6 16 1v3q-8-3-16 0Z" fill="#dfa275" /><path d="M16 8q0-6 5-6 0 5-5 6Z" fill="#a5c78d" /></>}
        {kind === "king" && <circle cx="12" cy="8" r="2" fill="#ffd677" />}
      </>;
  }
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" className="shrink-0" fill="none" stroke="#513c31" strokeWidth="1.4" strokeLinejoin="round" strokeLinecap="round">{art}</svg>;
}
