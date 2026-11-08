/** Shared contracts for the settings tab (health + settings endpoints). */

export interface LaneStatus {
  id: string;
  label: string;
  kind: "warp" | "user" | "direct";
  active: boolean;
  healthy: boolean;
  latencyMs: number | null;
  egressIp: string | null;
  lastCheck: number | null;
  note?: string;
}

export interface Health {
  engine: string | null;
  ffmpeg: boolean;
  cookies: boolean;
  clients: number;
  lanes: LaneStatus[];
  providers: string[];
}

export interface SettingsResp {
  cookiesConfigured: boolean;
  extraProxies: string;
  lanes: LaneStatus[];
}
