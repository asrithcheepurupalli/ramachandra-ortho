// Services offered, grouped. Icon names map to lucide-react icons.
export type Service = { name: string; icon: string };

export const serviceGroups: { group: string; items: Service[] }[] = [
  {
    group: "Facilities at the clinic",
    items: [
      { name: "Physiotherapy", icon: "Dumbbell" },
      { name: "Digital X-ray", icon: "Scan" },
    ],
  },
  {
    group: "Orthopedics & Trauma",
    items: [
      { name: "Fracture management", icon: "Bone" },
      { name: "Knee replacement", icon: "PersonStanding" },
      { name: "Hip replacement", icon: "Activity" },
      { name: "Spinal injuries", icon: "Spline" },
      { name: "Sports injuries", icon: "Volleyball" },
      { name: "Trauma care", icon: "Ambulance" },
      { name: "Rheumatology", icon: "HandHeart" },
    ],
  },
];
