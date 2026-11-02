import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type QuizAnswerGridProps = ComponentProps<"div">;

export function QuizAnswerGrid({ className, ...props }: QuizAnswerGridProps) {
  return (
    <div
      data-slot="quiz-answer-grid"
      className={cn(
        "grid h-full min-h-0 grid-cols-2 grid-rows-[repeat(2,minmax(0,1fr))] gap-2",
        className
      )}
      {...props}
    />
  );
}

type QuizAnswerChoiceProps = ComponentProps<"button"> & {
  variant?: "multiple-choice" | "ox";
};

export function QuizAnswerChoice({
  className,
  variant = "multiple-choice",
  ...props
}: QuizAnswerChoiceProps) {
  return (
    <button
      data-slot="quiz-answer-choice"
      type="button"
      className={cn(
        "flex h-full min-h-12 min-w-0 w-full items-center justify-center font-black shadow-xl transition-all focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-slate-900 motion-reduce:transition-none motion-reduce:hover:scale-100 motion-reduce:active:scale-100",
        variant === "ox"
          ? "rounded-[36px] border-b-[12px] text-7xl sm:min-h-48"
          : "items-center gap-2 rounded-[30px] border-b-6 px-3 py-2 text-left text-lg uppercase italic sm:py-3 [overflow-wrap:anywhere]",
        className
      )}
      {...props}
    />
  );
}
