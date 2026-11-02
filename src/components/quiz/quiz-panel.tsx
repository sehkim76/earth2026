import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

type QuizPanelProps = ComponentProps<"section">;

export function QuizPanel({ className, ...props }: QuizPanelProps) {
  return (
    <section
      data-slot="quiz-panel"
      className={cn("min-h-0 min-w-0", className)}
      {...props}
    />
  );
}
