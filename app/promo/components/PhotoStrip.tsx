import { DownloadIcon } from "lucide-react";
import type { PostView } from "../posts.server";

/**
 * The blog's photos in `[사진 n]` order. Naver's editor drops pasted images, so the owner saves
 * each one here and inserts it at its marker.
 */
export function PhotoStrip({ photos }: { photos: PostView["photos"] }) {
  if (photos.length === 0) return null;
  return (
    <section aria-labelledby="photo-strip-title" className="flex flex-col gap-2">
      <div>
        <h3 id="photo-strip-title" className="text-sm font-medium text-foreground/80">
          사진 순서
        </h3>
        <p className="text-xs text-muted-foreground">글의 [사진 1] 자리에 1번 사진을 넣어 주세요.</p>
      </div>
      <ol className="grid grid-cols-3 gap-2">
        {photos.map((p) => (
          <li key={p.id} className="flex min-w-0 flex-col gap-1">
            <div className="relative aspect-square overflow-hidden rounded-lg border bg-muted">
              <img
                src={`/img/${p.r2Key}`}
                alt={p.note ?? `사진 ${p.position}`}
                loading="lazy"
                className="size-full object-cover"
              />
              <span
                aria-hidden="true"
                className="absolute top-1 left-1 flex size-6 items-center justify-center rounded-full bg-black/70 text-xs font-semibold text-white"
              >
                {p.position}
              </span>
            </div>
            {p.note && <p className="line-clamp-2 text-xs break-words text-muted-foreground">{p.note}</p>}
            <a
              href={`/img/${p.r2Key}`}
              download={`사진-${p.position}.jpg`}
              aria-label={`사진 ${p.position} 저장`}
              className="flex h-11 items-center justify-center gap-1 rounded-md border border-input bg-card text-sm font-medium active:bg-accent"
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
              저장
            </a>
          </li>
        ))}
      </ol>
    </section>
  );
}
