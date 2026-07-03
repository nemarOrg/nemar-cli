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

export interface Notice {
  id: number;
  message: string;
  level: "info" | "warning" | "critical";
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
