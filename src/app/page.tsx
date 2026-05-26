import { redirect } from "next/navigation";
import { getCurrentUser, landingPageForRole } from "@/lib/auth";

export default async function RootPage() {
  const user = await getCurrentUser();
  redirect(`/${landingPageForRole(user.role)}`);
}
