type PlaceholderCardProps = {
  title: string;
  description?: string;
  hint?: string;
};

export function PlaceholderCard({ title, description, hint }: PlaceholderCardProps) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="text-sm font-medium text-slate-900">{title}</div>
      {description ? (
        <div className="mt-1 text-sm text-slate-500">{description}</div>
      ) : null}
      {hint ? (
        <div className="mt-4 rounded-md bg-slate-50 px-3 py-2 text-xs text-slate-500">
          {hint}
        </div>
      ) : null}
    </div>
  );
}
