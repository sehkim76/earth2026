'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { User, Sparkles, ArrowRight, RotateCcw } from 'lucide-react';
import { signIn } from 'next-auth/react';
import { THEME_CONFIG } from '@/lib/armissionwebconfig';
import {
  AUTH_DEVICE_STORAGE_KEY,
  AUTH_MAX_NICKNAME_LENGTH,
  AUTH_MIN_NICKNAME_LENGTH,
  AUTH_NICKNAME_REGEX,
  AUTH_NICKNAME_STORAGE_KEY,
} from '@/lib/auth-claim';


type NicknameInputProps = {
  title?: string;
  subtitle?: string;
  defaultValue?: string;
  minLen?: number;
  maxLen?: number;
  /**
   * 서버에서 전달한 ARMissionKey 초기값 (URL 쿼리에서 추출)
   */
  initialMissionKey?: string;

  /**
   * localStorage 저장 키
   */
  storageKey?: string;

  /**
   * 입력 허용 규칙: 기본은 한글/영문/숫자/공백/언더스코어
   */
  allowRegex?: RegExp;
   
};

export default function NicknameInput({
    title = '닉네임을 입력해 주세요',
    subtitle = '게임에서 표시될 이름이에요',
    defaultValue = '',
    minLen = AUTH_MIN_NICKNAME_LENGTH,
    maxLen = AUTH_MAX_NICKNAME_LENGTH,

    storageKey = AUTH_NICKNAME_STORAGE_KEY,
    allowRegex = AUTH_NICKNAME_REGEX,
    initialMissionKey = '',
}: NicknameInputProps) {
    const searchParams = useSearchParams();
    const rawCallbackUrl = searchParams?.get('callbackUrl') ?? null;
    const safeCallbackUrl = rawCallbackUrl && rawCallbackUrl.startsWith('/') && !rawCallbackUrl.startsWith('//')
        ? rawCallbackUrl
        : '/map';
    const ARMissionKey = useMemo(() => {
        if (initialMissionKey.trim().length > 0) {
            return initialMissionKey.trim();
        }
        const candidates: Array<string | null> = [
            searchParams?.get('ARMissionKey') ?? null,
            searchParams?.get('armissionkey') ?? null,
            searchParams?.get('armissionKey') ?? null,
        ];
        if (rawCallbackUrl) {
            try {
                const nested = new URL(rawCallbackUrl, window.location.origin).searchParams;
                candidates.push(
                    nested.get('ARMissionKey'),
                    nested.get('armissionkey'),
                    nested.get('armissionKey'),
                );
            } catch {
            }
        }
        for (const candidate of candidates) {
            const trimmed = candidate?.trim() ?? '';
            if (trimmed.length > 0) {
                return trimmed;
            }
        }
        return 'BUSANCITIZEN_ARBOOK';
    }, [searchParams, rawCallbackUrl, initialMissionKey]);
    
    console.log("[NicknameInput] ARMissionKey from URL:", ARMissionKey);
    
    const [value, setValue] = useState(defaultValue);
    const [touched, setTouched] = useState(false);
    const [availableNick, setAvailableNick] = useState<boolean>(false);  

    // ✅ LocalStorage에 저장된 닉네임
    const [savedNickname, setSavedNickname] = useState<string>('');
    const [authError, setAuthError] = useState<string>('');
    const deviceIdRef = useRef<string>('');

    // ✅ 저장된 닉네임을 보여줄지 여부
    const [useSavedView, setUseSavedView] = useState(false);

    
    const ensureDeviceId = useCallback((): string => {
        if (deviceIdRef.current) {
            return deviceIdRef.current;
        }

        const saved = window.localStorage.getItem(AUTH_DEVICE_STORAGE_KEY)?.trim() ?? '';
        if (saved) {
            deviceIdRef.current = saved;
            return saved;
        }

        const created = crypto.randomUUID();
        window.localStorage.setItem(AUTH_DEVICE_STORAGE_KEY, created);
        deviceIdRef.current = created;
        return created;
    }, [deviceIdRef]);

    const onConfirmedNickname = useCallback(async (nickname: string, targetDeviceId?: string) => {
        console.log("[NicknameInput] 로그인 시도 시작", { nickname, hasTargetDeviceId: !!targetDeviceId, ARMissionKey });
        
        const resolvedDeviceId = targetDeviceId ?? ensureDeviceId();
        console.log("[NicknameInput] deviceId 확보", { resolvedDeviceId });
        
        if (!resolvedDeviceId) {
            console.error("[NicknameInput] 기기 식별 정보 없음");
            setAuthError('기기 식별 정보를 확인할 수 없습니다. 다시 시도해 주세요.');
            return;
        }

        console.log("[NicknameInput] signIn 호출 전", { nickname, resolvedDeviceId, ARMissionKey });
        
        const result = await signIn('credentials', {
            redirect: false,
            nickname,
            deviceId: resolvedDeviceId,
            ARMissionKey,
            callbackUrl: safeCallbackUrl,
        });

        console.log("[NicknameInput] signIn 결과", { result, error: result?.error });

        if (!result || result.error) {
            console.error("[NicknameInput] 로그인 실패", { error: result?.error });
            setAuthError('이미 다른 기기에서 사용 중인 아이디이거나 로그인에 실패했습니다.');
            return;
        }

        console.log("[NicknameInput] 로그인 성공, localStorage 저장", { nickname });
        
        try {
            window.localStorage.setItem(storageKey, nickname);
            console.log("[NicknameInput] localStorage 저장 완료");
        } catch (e) {
            console.error("[NicknameInput] localStorage 저장 실패", e);
        }

        console.log("[NicknameInput] /map으로 이동");
        window.location.href = safeCallbackUrl;
    }, [ensureDeviceId, storageKey, ARMissionKey, safeCallbackUrl]);




    // ✅ 클라이언트에서 localStorage 로드
    useEffect(() => {
            try {
            ensureDeviceId();

            const saved = window.localStorage.getItem(storageKey)?.trim() ?? '';
            if (saved) {
                setTimeout(() => {
                    setSavedNickname(saved);
                    setUseSavedView(true);
                }, 0);
            }
            } catch {
            // localStorage 접근 실패(사파리 프라이빗 등) 시 무시
            }
    }, [ensureDeviceId, storageKey]);


    const trimmed = useMemo(() => value.trim(), [value]);

    const canSubmit = trimmed.length >= minLen && trimmed.length <= maxLen && allowRegex.test(trimmed);

    const handleSubmit = async () => {
        setTouched(true);
        if (!canSubmit) return;

        setAuthError('');
        await onConfirmedNickname(trimmed);
    };

    //const a = ['용감한', '반짝이는', '신비한', '빠른', '차분한', '똑똑한', '귀여운'];
    //const b = ['탐험가', '라이더', '마법사', '도전자', '챔피언', '연구자', '크리에이터'];

    const a = ['용감한', '밝은', ' 웃긴', '사랑스런', '귀여운', '멋진', '씩씩한', '당당한', '똑똑한', '용감'];
    const b = ['탐험가', '라이더', '마법사', '도전자', '챔피언', '연구자', '크리에이터', '히어로', '레전드', '어린이'];

    const checkNickname = useCallback(async (nickname: string) => {
    console.log("[checkNickname] 시작:", nickname);
    try {
        const resolvedDeviceId = ensureDeviceId();

        const res = await fetch('/api/login/check_nickname', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ nickname, deviceId: resolvedDeviceId }),
        });
        const data = (await res.json()) as { result?: string };
        
        console.log("[checkNickname] 결과:", data);

        if (data.result === 'duplicate' || data.result === 'invalid') {
            console.log("[checkNickname] 중복/유효하지 않음 -> false");
            setAvailableNick(false);
        } else {
            console.log("[checkNickname] 사용 가능 -> true");
            setAvailableNick(true);
        }
    } catch (e) {
        console.log("[checkNickname] 에러:", e);
        setAvailableNick(false);
    }
    }, [ensureDeviceId]);

    const debounceRef = useRef<NodeJS.Timeout | null>(null);


    const generateRandomNickname = () => {
        const adj = a[Math.floor(Math.random() * a.length)];
        const noun = b[Math.floor(Math.random() * b.length)];
        return adj + noun;
    };

    const generateRandomNumber = (min: number, max: number) => {
        return Math.floor(Math.random() * (max - min)) + min;
    }

    const randomNick = async () => {
        const resolvedDeviceId = ensureDeviceId();
        const r : string = generateRandomNickname();
        let rn : string = r;
        
        console.log("[randomNick] 생성된 닉네임:", rn);
        
        let res = await fetch('/api/login/check_nickname', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({ nickname: r, deviceId: resolvedDeviceId }),
        });
        let data = (await res.json()) as { result?: string };
        
        console.log("[randomNick] 첫 결과:", data);

        while (data.result === 'duplicate') {
            rn = r + generateRandomNumber(0, 10000).toString();
            console.log("[randomNick] 중복, 새 닉네임:", rn);
            res = await fetch('/api/login/check_nickname', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ nickname: rn, deviceId: resolvedDeviceId }),
            });
            data = (await res.json()) as { result?: string };
            console.log("[randomNick] 재확인 결과:", data);
        }
        
        console.log("[randomNick] 최종:", rn, "result:", data.result);
        
        setValue(rn);
        setTouched(true);
        setAvailableNick(data.result === 'unique' || data.result === 'owned');
    };

    const changeNickname = () => {
        // ✅ 입력 모드로 복귀
        setUseSavedView(false);
        setValue('');
        setTouched(false);
        setAuthError('');
        setAvailableNick(false);

        try {
            window.localStorage.removeItem(storageKey);
        } catch {
        }
    };

    // =========================
    // 1) 저장된 닉네임 뷰
    // =========================
    if (useSavedView && savedNickname) {
        return (
            <div className="flex-1 flex flex-col items-center justify-center p-4">
                <div className="w-full max-w-md rounded-[50px] bg-white shadow-2xl border-b-[16px] border-slate-100 p-8">
                <div className="flex flex-col items-center text-center gap-4">
                    <div className="w-20 h-20 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-2xl ring-[14px] ring-slate-100">
                    <User size={40} strokeWidth={3} />
                    </div>

                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter italic uppercase">
                        환영합니다!
                    </h1>

                    <div
                        className="
                        w-full p-5 bg-slate-50 rounded-[35px]
                        text-center text-2xl font-black
                        shadow-inner uppercase italic
                        border-b-[12px] border-slate-100
                        text-slate-800
                        "
                    >
                        {savedNickname}
                    </div>

                    <div className="w-full grid grid-cols-2 gap-3 pt-2">
                    <button
                        type="button"
                        onClick={changeNickname}
                        className="
                        w-full py-5 rounded-[28px]
                        bg-slate-100 text-slate-700
                        font-black text-lg
                        shadow-xl active:translate-y-2 transition-all
                        uppercase italic border-b-[10px] border-slate-200
                        flex items-center justify-center gap-2
                        "
                    >
                        <RotateCcw size={20} strokeWidth={3} />
                        변경
                    </button>

                    <button
                        type="button"
                        onClick={() => onConfirmedNickname(savedNickname)}
                        className={`
                            w-full py-5 rounded-[28px]
                            text-white font-black text-lg
                            shadow-xl active:translate-y-2 transition-all
                            uppercase italic border-b-[10px] border-black/20
                            flex items-center justify-center gap-2                            
                            ${THEME_CONFIG.pythagoras.bgClass}
                        `}
                    >
                        계속하기
                        <ArrowRight size={20} strokeWidth={3} />
                    </button>
                    </div>
                </div>
                </div>
            </div>
        );
    }

    // =========================
    // 2) 입력 뷰
    // =========================
    return (
        <div className="flex-1 flex flex-col items-center justify-center p-4">
            <div className="w-full max-w-md rounded-[50px] bg-white shadow-2xl border-b-[16px] border-slate-100 p-8">
                <div className="flex flex-col items-center text-center gap-4">
                <div className="w-20 h-20 rounded-full bg-slate-900 text-white flex items-center justify-center shadow-2xl ring-[14px] ring-slate-100">
                    <User size={40} strokeWidth={3} />
                </div>

                <div className="space-y-1">
                    <h1 className="text-3xl font-black text-slate-800 tracking-tighter italic uppercase">
                    {title}
                    </h1>
                    <p className="text-slate-400 font-black text-base italic uppercase tracking-widest">
                    {subtitle}
                    </p>
                </div>

                <div className="w-full mt-4 space-y-3">
                    <input
                        value={value}
                        onChange={(e) => {
                            const next = e.target.value;
                            setValue(next);
                            if (!touched) setTouched(true);

                            if (debounceRef.current) clearTimeout(debounceRef.current);

                            debounceRef.current = setTimeout(() => {
                            const nick = next.trim();
                            if (nick.length >= minLen && nick.length <= maxLen && allowRegex.test(nick)) {
                                checkNickname(nick);
                            } else {
                                setAvailableNick(false);
                            }
                            }, 250);
                        }}

                        onKeyDown={(e) => {
                            if (e.key === 'Enter') handleSubmit();
                        }}
                        onBlur={() => setTouched(true)}
                        placeholder="NICKNAME"
                        className="
                            w-full p-5 bg-slate-50 rounded-[35px]
                            text-center text-2xl font-black
                            outline-none shadow-inner uppercase italic
                            placeholder:text-slate-200
                            border-b-[12px] border-slate-100
                            focus:border-indigo-100 text-slate-800
                        "
                        maxLength={maxLen + 10}
                        autoComplete="off"
                        inputMode="text"
                    />

                    <div className="flex items-center justify-between px-2">
                    <div className="text-left min-h-[20px]">
                        { authError ? (
                        <p className="text-red-500 font-black italic text-xs uppercase tracking-wide">{authError}</p>
                        ) : !availableNick && value.length > minLen ? (
                        <p className="text-red-500 font-black italic text-xs uppercase tracking-wide">중복</p>
                        ) : (
                        <p className="text-slate-300 font-black italic text-xs uppercase tracking-wide">
                            { touched ? '좋아요!' : ' '}
                        </p>
                        )}
                    </div>

                    <div className="text-slate-300 font-black italic text-xs">
                        {Math.min(trimmed.length, 999)}/{maxLen}
                    </div>
                    </div>

                    <div className="grid grid-cols-2 gap-3 pt-1">
                    <button
                        type="button"
                        onClick={randomNick}
                        className="
                        w-full py-5 rounded-[28px]
                        bg-slate-100 text-slate-700
                        font-black text-lg
                        shadow-xl active:translate-y-2 transition-all
                        uppercase italic border-b-[10px] border-slate-200
                        flex items-center justify-center gap-2
                        "
                    >
                        <Sparkles size={20} strokeWidth={3} />
                        랜덤
                    </button>

                    <button
                        type="button"
                        onClick={handleSubmit}
                        disabled={!canSubmit}
                        className={`
                            w-full py-5 rounded-[28px]
                            text-white font-black text-lg
                            shadow-xl active:translate-y-2 transition-all
                            uppercase italic border-b-[10px] border-black/20
                            flex items-center justify-center gap-2
                            ${availableNick ? '' : 'opacity-50 cursor-not-allowed'}
                            ${canSubmit ? THEME_CONFIG.pythagoras.bgClass : 'bg-slate-200 text-white/70 shadow-none'}
                        `}
                    >
                        시작하기
                        <ArrowRight size={20} strokeWidth={3} />
                    </button>
                    </div>
                </div>
                </div>
            </div>

            <div className="mt-4 text-center text-slate-300 font-black italic uppercase text-xs">
                한글/영문/숫자/공백/_(언더스코어) · {minLen}~{maxLen}자
            </div>
        </div>
    );
}
