import type { MetadataRoute } from "next";
import { demoRequested } from "@/lib/demo/config";

export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: "*", ...(demoRequested() ? { disallow: "/" } : { allow: "/" }) } };
}
