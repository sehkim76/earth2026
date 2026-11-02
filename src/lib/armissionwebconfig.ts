import { Circle, Square, Triangle } from "lucide-react";

// --- 테마 및 게임 설정 ---
export const THEME_CONFIG = {
  pythagoras: {
    id: 'pythagoras',
    label: '피타고라스의 지평',
    mainColor: '#46178F',
    bgClass: 'bg-[#46178F]',
    shape: Triangle,
    games: [
      { id: 'PYTHAGORAS_BUILDER', label: '직각삼각형 빌더', desc: '정확한 90도 삼각형 만들기' },
      { id: 'ANGLE_MATCH', label: '각도 맞추기', desc: '주어진 각도만큼 선 회전하기' }
    ]
  },
  pi_day: {
    id: 'pi_day',
    label: '원주율의 지평',
    mainColor: '#1368CE',
    bgClass: 'bg-[#1368CE]',
    shape: Circle,
    games: [
      { id: 'PI_ROLLER', label: '원주율 굴리기', desc: '3.14 거리에 맞춰 멈추기' },
      { id: 'CIRCLE_FIT', label: '원 크기 맞추기', desc: '지름에 맞는 원주 크기 조절' }
    ]
  },
  golden_ratio: {
    id: 'golden_ratio',
    label: '황금비의 지평',
    mainColor: '#26890C',
    bgClass: 'bg-[#26890C]',
    shape: Square,
    games: [
      { id: 'GOLDEN_RECT', label: '황금사각형 메이커', desc: '1:1.618 비율 조절하기' },
      { id: 'FIBONACCI_SPIRAL', label: '피보나치 나선 연결', desc: '순서대로 나선 그리기' }
    ]
  }
};
