import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

// Excel import templates have been removed from public workflows along with the
// public import flow. The endpoint now returns 404 without revealing anything.
// TODO(it-service-import): a service template may later be exposed ONLY to the
// platform IT Specialist contour. The xlsx builder lives in git history.
export async function GET() {
  return new NextResponse("Not found", { status: 404 });
}
