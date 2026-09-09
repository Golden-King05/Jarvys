import type { RegionStatus } from "../api";

export function statusColor(status?: RegionStatus): string {
  switch (status) {
    case "green":
      return "#27ae60";
    case "yellow":
      return "#f39c12";
    case "red":
      return "#c0392b";
    default:
      return "#2980b9";
  }
}

export function statusLabel(status?: RegionStatus): string {
  switch (status) {
    case "green":
      return "Allowed";
    case "yellow":
      return "Permit / restricted";
    case "red":
      return "Not allowed";
    default:
      return "Highlighted";
  }
}
