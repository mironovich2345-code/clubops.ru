"use client";

import { useRef, useState } from "react";
import { useFormStatus } from "react-dom";

const DEFAULT_ACCEPT = ".jpg,.jpeg,.png,.webp,.pdf";

function human(bytes: number) {
  if (bytes < 1024) return `${bytes} Б`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} КБ`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} МБ`;
}

/**
 * Unified mobile file field (spec §17). Wraps a real `<input type="file" name>` so it still
 * submits through the existing server actions (no new upload path). Adds: a camera-capture
 * button (`capture="environment"`) + a library/files button, a per-file preview list with
 * individual remove (rebuilds the input's FileList via DataTransfer), count + size display, a
 * max-count guard, and disables itself while the form is pending (anti double-tap).
 */
export function MobileFileField({
  name,
  accept = DEFAULT_ACCEPT,
  maxFiles = 3,
  maxSizeMb = 10,
  required = false,
  hint,
}: {
  name: string;
  accept?: string;
  maxFiles?: number;
  maxSizeMb?: number;
  required?: boolean;
  hint?: string;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const [files, setFiles] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { pending } = useFormStatus();

  const sync = (next: File[]) => {
    const dt = new DataTransfer();
    next.forEach((f) => dt.items.add(f));
    if (inputRef.current) inputRef.current.files = dt.files;
    setFiles(next);
  };

  const add = (incoming: FileList | null) => {
    if (!incoming || incoming.length === 0) return;
    setError(null);
    const merged = [...files];
    for (const f of Array.from(incoming)) {
      if (merged.length >= maxFiles) { setError(`Не больше ${maxFiles} файлов`); break; }
      if (f.size > maxSizeMb * 1024 * 1024) { setError(`«${f.name}» больше ${maxSizeMb} МБ`); continue; }
      if (!merged.some((m) => m.name === f.name && m.size === f.size)) merged.push(f);
    }
    sync(merged);
  };

  const remove = (i: number) => sync(files.filter((_, idx) => idx !== i));

  return (
    <div className="space-y-2">
      {/* The real, submitted input — kept in sync via DataTransfer; visually hidden. */}
      <input ref={inputRef} type="file" name={name} accept={accept} multiple={maxFiles > 1} required={required && files.length === 0} className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => add(e.currentTarget.files)} />
      {/* Camera-only helper input (not submitted); its picks are merged into the real input. */}
      <input ref={cameraRef} type="file" accept="image/*" capture="environment" className="sr-only" tabIndex={-1} aria-hidden onChange={(e) => { add(e.currentTarget.files); e.currentTarget.value = ""; }} />

      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={pending || files.length >= maxFiles} onClick={() => cameraRef.current?.click()} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 disabled:opacity-50">
          <span aria-hidden>📷</span> Камера
        </button>
        <button type="button" disabled={pending || files.length >= maxFiles} onClick={() => inputRef.current?.click()} className="inline-flex min-h-[44px] items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 text-sm font-medium text-slate-700 disabled:opacity-50">
          <span aria-hidden>📎</span> Из файлов
        </button>
      </div>

      <p className="text-xs text-slate-500">Файлов: {files.length} из {maxFiles}{hint ? ` · ${hint}` : ""}</p>
      {error ? <p className="text-xs text-rose-600" role="alert">{error}</p> : null}

      {files.length > 0 ? (
        <ul className="space-y-1">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center justify-between gap-2 rounded-md border border-slate-200 bg-white px-2 py-1.5">
              <span className="min-w-0 break-anywhere text-sm text-slate-700">{f.name}</span>
              <span className="flex shrink-0 items-center gap-2">
                <span className="text-xs text-slate-400">{human(f.size)}</span>
                <button type="button" disabled={pending} onClick={() => remove(i)} aria-label={`Удалить ${f.name}`} className="flex h-8 w-8 items-center justify-center rounded text-slate-500 hover:bg-slate-100 disabled:opacity-50">✕</button>
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
