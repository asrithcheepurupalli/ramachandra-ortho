import type { MetadataRoute } from "next";
import { clinic } from "@/clinic.config";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: clinic.name,
    short_name: clinic.shortName,
    description: clinic.tagline,
    start_url: "/",
    display: "standalone",
    background_color: "#f5f8f6",
    theme_color: "#0c7a68",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
