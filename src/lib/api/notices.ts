/**
 * NEMAR API client: system notices. getNotices is the optional-auth CLI
 * startup path (lib/notices.ts); keeping the cluster in its own module keeps
 * the admin endpoint module out of the startup import graph.
 *
 * Split from lib/api.ts by endpoint group (#908, epic #902); bodies moved
 * verbatim.
 */

import { request } from "./client.js";

// ============================================================================
// Notices
// ============================================================================

/**
 * Notice severity (#1025), most urgent first — also the stacking order the
 * website renders. `info` was renamed to `tip` by migration 0063; the API
 * still accepts `info` on write and normalizes it, so this union covers what
 * can be *read back*, which never includes `info`.
 */
export type NoticeLevel = "critical" | "warning" | "maintenance" | "announcement" | "tip";

export const NOTICE_LEVELS: NoticeLevel[] = [
  "critical",
  "warning",
  "maintenance",
  "announcement",
  "tip",
];

export interface Notice {
  id: number;
  message: string;
  level: NoticeLevel;
  scope: "all" | "admins" | "members";
  created_at: string;
  expires_at: string | null;
}

/**
 * Get active notices for the current user's role (optional auth)
 */
export async function getNotices(): Promise<{ notices: Notice[] }> {
  return request<{ notices: Notice[] }>("/notices", {}, "optional");
}

/**
 * List all notices including expired (admin only)
 */
export async function listAdminNotices(): Promise<{ notices: Notice[] }> {
  return request<{ notices: Notice[] }>("/admin/notices", {}, true);
}

/**
 * Create a notice (admin only)
 */
export async function createNotice(data: {
  message: string;
  level?: string;
  scope?: string;
  expires_at?: string;
}): Promise<Notice> {
  return request<Notice>(
    "/admin/notices",
    {
      method: "POST",
      body: JSON.stringify(data),
    },
    true,
  );
}

/**
 * Delete a notice (admin only)
 */
export async function deleteNotice(id: number): Promise<{ message: string }> {
  return request<{ message: string }>(`/admin/notices/${id}`, { method: "DELETE" }, true);
}
