import "server-only";

// SERVER-ONLY navigation resolver. May use auth capabilities (which transitively pull
// session.ts → next/headers). Keeping this out of navigation.ts is what stops the
// client bundle (Sidebar/MobileShell) from dragging next/headers in. Returns only
// serializable values (page-key arrays) for passing to components as props.
import { highestRole, type Role } from "@/lib/auth";
import { bottomNavOrderForRole } from "@/lib/navigation";
import type { AppPage } from "@/lib/auth";

/** Preferred bottom-nav page order for a user's effective roles (highest role wins). */
export function bottomNavOrder(roles: readonly Role[]): AppPage[] {
  return bottomNavOrderForRole(highestRole(roles));
}
