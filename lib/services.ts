// Services offered, grouped. Icon names map to lucide-react icons.
export type Service = { name: string; icon: string };

export const serviceGroups: { group: string; items: Service[] }[] = [
  {
    group: "Orthopedics & Trauma",
    items: [
      { name: "Fracture management", icon: "Bone" },
      { name: "Joint replacement", icon: "PersonStanding" },
      { name: "Hip replacement", icon: "Activity" },
      { name: "Spinal injuries", icon: "Spline" },
      { name: "Sports injuries", icon: "Volleyball" },
      { name: "Trauma care", icon: "Ambulance" },
      { name: "Physiotherapy", icon: "Dumbbell" },
      { name: "Rheumatology", icon: "HandHeart" },
    ],
  },
  {
    group: "General care",
    items: [
      { name: "Emergency care", icon: "Siren" },
      { name: "Consultation", icon: "Stethoscope" },
      { name: "Hernia", icon: "ShieldPlus" },
      { name: "Hydrocele", icon: "Droplet" },
      { name: "Piles", icon: "CircleDot" },
    ],
  },
];
