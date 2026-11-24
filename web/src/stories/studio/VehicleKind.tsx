// "What is it?" (docs/CONTRACTS.md §45.47): the kind of vehicle a new vehicle is, as icon-and-word tiles (Car, Truck,
// Bus, Motorbike, Plane, Boat) under the sliding highlight (Pick). It is never stored: the design gets it as
// `vehicle` (the bodies the agent may use), and a vehicle's family is always worked out from its body (VEHICLE_OF).
import type { VehicleType } from "../api/types.ts";
import type { CarBody } from "../engine/types.ts";
import { Pick, type PickOption } from "./kit.tsx";

/** The tiles, in the owner's order. */
export const VEHICLE_KINDS: { value: VehicleType; label: string }[] = [
  { value: "car", label: "Car" },
  { value: "truck", label: "Truck" },
  { value: "bus", label: "Bus" },
  { value: "motorbike", label: "Motorbike" },
  { value: "plane", label: "Plane" },
  { value: "boat", label: "Boat" },
];

/** The body a new vehicle of each kind starts as (the first of its family, §45.47 D6). */
export const FIRST_BODY: Record<VehicleType, CarBody> = {
  car: "hatchback",
  truck: "pickup",
  bus: "bus",
  motorbike: "motorbike",
  plane: "plane",
  boat: "boat",
};

/** Simple line icons (24 x 24, stroked in the text colour), one per kind. */
const ICON: Record<VehicleType, string> = {
  car: "M5 17H4a1 1 0 0 1-1-1v-3.2a2 2 0 0 1 .4-1.2L5.6 8.4a2 2 0 0 1 1.6-.9h7.6a2 2 0 0 1 1.5.7l2.7 3.3 1.7.5a1.5 1.5 0 0 1 1.1 1.4V16a1 1 0 0 1-1 1h-1M9 17h6M7 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM17 15a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM3.6 11.5H19",
  truck: "M2 6h11v10H2zM13 9h4l3.5 3.5V16H13M6 16a2 2 0 1 0 0 4 2 2 0 1 0 0-4zM17 16a2 2 0 1 0 0 4 2 2 0 1 0 0-4z",
  bus: "M5 4h14a1 1 0 0 1 1 1v12H4V5a1 1 0 0 1 1-1zM4 11h16M8 4v7M16 4v7M7 17v2M17 17v2M7 14h.01M17 14h.01",
  motorbike: "M5 13a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM19 13a3 3 0 1 0 0 6 3 3 0 1 0 0-6zM5 16l4-5h5l3-4h2M9 11l3 5h4M14 7h3",
  plane: "M21 15.5 13.5 12V6.5a1.5 1.5 0 0 0-3 0V12L3 15.5V17l7.5-2v3.5L8.5 20v1.5L12 20.5l3.5 1V20l-2-1.5V15l7.5 2z",
  boat: "M3 15h18l-2.5 4.5H5.5zM12 3v12M12 4l6 9h-6M12 7l-4 6h4M2 21c2 0 2-1 4-1s2 1 4 1 2-1 4-1 2 1 4 1 2-1 4-1",
};

function KindIcon({ kind }: { kind: VehicleType }) {
  return (
    <svg className="st-s-vkind__icon" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={ICON[kind]} />
    </svg>
  );
}

const OPTIONS: PickOption<VehicleType>[] = VEHICLE_KINDS.map((k) => ({ ...k, art: <KindIcon kind={k.value} /> }));

/** "What is it?": the six kinds, on a backing plate (it sits loose on the page). */
export function VehicleKind({ value, onChange }: { value: VehicleType; onChange: (v: VehicleType) => void }) {
  return (
    <div className="st-plate st-s-vkindbox">
      <Pick label="What is it?" big value={value} options={OPTIONS} onChange={onChange} className="st-s-vkind" />
    </div>
  );
}
