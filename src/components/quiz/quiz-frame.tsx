import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type QuizFrameProps = ComponentProps<"main"> & {
  isShortAnswer: boolean;
};

export function QuizFrame({ isShortAnswer, className, ...props }: QuizFrameProps) {
  return (
    <main
      data-slot="quiz-frame"
      className={cn(
        "relative z-10 grid h-full min-h-0 min-w-0 gap-3 overflow-hidden p-3 pb-[calc(var(--spacing)*3+env(safe-area-inset-bottom,0px))] sm:p-4 sm:pb-[calc(var(--spacing)*4+env(safe-area-inset-bottom,0px))] animate-in zoom-in motion-reduce:animate-none",
        isShortAnswer
          ? "grid-rows-[auto_minmax(0,4fr)_minmax(0,1fr)]"
          : "grid-rows-[auto_minmax(0,3fr)_minmax(0,2fr)]",
        className
      )}
      {...props}
    />
  );
}
