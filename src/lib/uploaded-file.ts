// Server-safe uploaded-file handling.
//
// The browser `File` global only exists on Node >= 20. On older Node runtimes
// (as on some Railway images) referencing `File` — e.g. `value instanceof File`
// — throws `ReferenceError: File is not defined`. We therefore never touch the
// `File` global on the server: we duck-type the FormData value instead.

export type UploadedFile = {
  name: string;
  type: string;
  size: number;
  arrayBuffer(): Promise<ArrayBuffer>;
};

export function isUploadedFile(value: unknown): value is UploadedFile {
  if (value == null || typeof value !== "object") return false;
  const v = value as Partial<UploadedFile>;
  return (
    typeof v.arrayBuffer === "function" &&
    typeof v.size === "number" &&
    typeof v.name === "string" &&
    typeof v.type === "string"
  );
}
