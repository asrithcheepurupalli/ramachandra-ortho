import type { MetadataRoute } from "next";
import { clinic } from "@/clinic.config";

export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: "/admin" },
    sitemap: `${clinic.url}/sitemap.xml`,
    host: clinic.url,
  };
}
