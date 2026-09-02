import type { MetadataRoute } from "next";
import { clinic } from "@/clinic.config";

export default function sitemap(): MetadataRoute.Sitemap {
  const now = new Date();
  return [
    { url: clinic.url, lastModified: now, changeFrequency: "weekly", priority: 1 },
    { url: `${clinic.url}/book`, lastModified: now, changeFrequency: "weekly", priority: 0.9 },
    { url: `${clinic.url}/privacy`, lastModified: now, changeFrequency: "yearly", priority: 0.3 },
  ];
}
