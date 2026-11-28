import { NextResponse } from "next/server";

/** 이전 버전의 지도 탭에서 보내는 선택·해제 요청을 수신만 한다. */
export function POST(): NextResponse {
  return NextResponse.json({ ok: true });
}
