import { redirect } from "next/navigation";
import { landingPageForRole } from "@/lib/auth";
import { getCurrentAccessContext } from "@/lib/access";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const ctx = await getCurrentAccessContext();
  if (!ctx) redirect("/login");
  if (!ctx.effectiveRole) redirect("/no-access");
  redirect(`/${landingPageForRole(ctx.effectiveRole)}`);
}
