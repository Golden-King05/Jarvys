import { useEffect, useRef, useState } from "react";
import type { PointTag } from "../api";

// Lets an OSM element's tag editor feel instant while typing, with the
// actual PATCH request debounced behind the scenes. Wiring TagsEditor
// straight to a per-keystroke save (its onChange fires on every character)
// means the next render reflects whatever the *server* echoed back, which
// can race ahead of what's still being typed — confirmed by hand: clicking
// "+ Add tag" adds a blank-header row, and since an empty key never
// round-trips back as a real tag (both here and in the app's own point-tags
// save path), the row would vanish again before its header could be typed,
// clobbering the very thing the user just clicked.
//
// `key` identifies which element the draft belongs to (e.g. "node/123") —
// the draft resets to `initialTags` only when this changes, not on every
// render, so an unrelated re-render of the parent never clobbers an
// in-progress edit.
export function useDebouncedTagsDraft(
  key: string,
  initialTags: PointTag[],
  onSave: (tags: PointTag[]) => void,
  delayMs = 600
): [PointTag[], (tags: PointTag[]) => void] {
  const [draft, setDraft] = useState<PointTag[]>(initialTags);
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const pending = useRef<{ tags: PointTag[]; timer: ReturnType<typeof setTimeout>; saveFn: (tags: PointTag[]) => void } | null>(
    null
  );

  useEffect(() => {
    setDraft(initialTags);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Flushes any pending save for the *previous* key before switching to a
  // new one (or unmounting) — using the saveFn captured at schedule time
  // (see change() below), not a freshly-read ref, so this can't race ahead
  // to save into whatever element just became selected.
  useEffect(() => {
    return () => {
      if (pending.current) {
        clearTimeout(pending.current.timer);
        pending.current.saveFn(pending.current.tags);
        pending.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  function change(tags: PointTag[]) {
    setDraft(tags);
    if (pending.current) clearTimeout(pending.current.timer);
    // Captured now (synchronously, while `key` still matches the element
    // being typed into) rather than read again when the timer fires.
    const saveFn = onSaveRef.current;
    const timer = setTimeout(() => {
      saveFn(tags);
      pending.current = null;
    }, delayMs);
    pending.current = { tags, timer, saveFn };
  }

  return [draft, change];
}
