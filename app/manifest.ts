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
    icons: [
      { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icon.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
    shortcuts: [
      {
        name: "Admin Dashboard",
        short_name: "Admin",
        description: "Manage today's queue and appointments",
        url: "/admin",
        icons: [{ src: "/icon-admin.png", sizes: "192x192", type: "image/png" }],
      },
      {
        name: "Doctor Dashboard",
        short_name: "Doctor",
        description: "View today's patient list",
        url: "/doctor",
        icons: [{ src: "/icon-doctor.png", sizes: "192x192", type: "image/png" }],
      },
    ],
  };
}
