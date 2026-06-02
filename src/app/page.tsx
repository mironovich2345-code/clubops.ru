import { redirect } from "next/navigation";
import { getCurrentUser, landingPageForRole } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function RootPage() {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(`/${landingPageForRole(user.role)}`);
}
