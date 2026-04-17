export const MAINTENANCE_MODES = ["off", "read-only", "full"] as const;

export type MaintenanceMode = (typeof MAINTENANCE_MODES)[number];

export type ActiveMaintenanceMode = Exclude<MaintenanceMode, "off">;

export function isMaintenanceMode(value: unknown): value is MaintenanceMode {
  return typeof value === "string" && (MAINTENANCE_MODES as readonly string[]).includes(value);
}

export function isActiveMaintenanceMode(value: unknown): value is ActiveMaintenanceMode {
  return value === "read-only" || value === "full";
}
