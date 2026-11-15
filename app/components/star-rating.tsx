import { useState } from "react";
import { useFetcher } from "react-router";
import { Star } from "lucide-react";
import { cn } from "~/lib/utils";

const STAR_VALUES = [1, 2, 3, 4, 5];

function StarIcon({ fill, className }: { fill: number; className?: string }) {
  // fill is 0–1: how much of this star is coloured in
  return (
    <span className={cn("relative inline-block shrink-0", className)}>
      <Star className="size-full text-muted-foreground/40" />
      {fill > 0 && (
        <Star
          className="absolute inset-0 size-full fill-amber-400 text-amber-400"
          style={{ clipPath: `inset(0 ${100 - fill * 100}% 0 0)` }}
        />
      )}
    </span>
  );
}

export function StarRatingDisplay({
  average,
  count,
  className,
  starClassName = "size-3.5",
}: {
  average: number | null;
  count: number;
  className?: string;
  starClassName?: string;
}) {
  if (count === 0 || average === null) {
    return (
      <span className={cn("text-muted-foreground", className)}>
        No ratings yet
      </span>
    );
  }

  // Round to the nearest half star for display
  const rounded = Math.round(average * 2) / 2;

  return (
    <span
      className={cn("inline-flex items-center gap-1", className)}
      aria-label={`Rated ${average.toFixed(1)} out of 5 from ${count} ${count === 1 ? "rating" : "ratings"}`}
    >
      <span className="inline-flex items-center" aria-hidden>
        {STAR_VALUES.map((n) => (
          <StarIcon
            key={n}
            fill={Math.min(Math.max(rounded - (n - 1), 0), 1)}
            className={starClassName}
          />
        ))}
      </span>
      <span className="font-medium text-foreground">{average.toFixed(1)}</span>
      <span className="text-muted-foreground">({count})</span>
    </span>
  );
}

export function StarRatingInput({ value }: { value: number | null }) {
  const fetcher = useFetcher();
  const [hovered, setHovered] = useState<number | null>(null);

  // Optimistic value: submitting the current rating again removes it
  const pendingRating = fetcher.formData
    ? Number(fetcher.formData.get("rating"))
    : undefined;
  const current =
    pendingRating === undefined
      ? value
      : pendingRating === value
        ? null
        : pendingRating;
  const shown = hovered ?? current ?? 0;

  return (
    <fetcher.Form method="post" className="space-y-1">
      <input type="hidden" name="intent" value="rate" />
      <div className="text-sm font-medium">
        {current ? `Your rating ${current}/5` : "Rate this course"}
      </div>
      <div
        className="flex items-center gap-0.5"
        onMouseLeave={() => setHovered(null)}
      >
        {STAR_VALUES.map((n) => (
          <button
            key={n}
            type="submit"
            name="rating"
            value={n}
            aria-label={
              current === n
                ? "Remove your rating"
                : `Rate ${n} ${n === 1 ? "star" : "stars"}`
            }
            title={current === n ? "Click again to remove your rating" : undefined}
            aria-pressed={current === n}
            onMouseEnter={() => setHovered(n)}
            onFocus={() => setHovered(n)}
            onBlur={() => setHovered(null)}
            className="cursor-pointer rounded p-0.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <StarIcon fill={n <= shown ? 1 : 0} className="size-6" />
          </button>
        ))}
      </div>
    </fetcher.Form>
  );
}
