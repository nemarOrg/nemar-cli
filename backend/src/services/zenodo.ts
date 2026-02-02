/**
 * Zenodo API service
 *
 * Handles DOI creation and publishing for NEMAR datasets.
 * DOIs are PERMANENT and cannot be deleted - only marked obsolete.
 *
 * Two DOI types:
 * - Concept DOI: Parent DOI that groups all versions (created by admin)
 * - Version DOI: Specific version DOI (created automatically on release)
 */

const ZENODO_API_URL = "https://zenodo.org/api";
const ZENODO_SANDBOX_URL = "https://sandbox.zenodo.org/api";

export interface ZenodoCreator {
  name: string; // "Last, First" format
  affiliation?: string;
  orcid?: string;
}

export interface ZenodoMetadata {
  title: string;
  description: string;
  creators: ZenodoCreator[];
  keywords?: string[];
  license?: string;
  version?: string;
  publication_date?: string;
  related_identifiers?: Array<{
    identifier: string;
    relation: string;
    resource_type?: string;
  }>;
}

export interface ZenodoDeposition {
  id: number;
  conceptrecid?: number;
  doi?: string;
  doi_url?: string;
  state: "unsubmitted" | "inprogress" | "done" | "error";
  submitted: boolean;
  metadata: {
    title: string;
    doi?: string;
    prereserve_doi?: {
      doi: string;
      recid: number;
    };
  };
  links: {
    self: string;
    html: string;
    bucket?: string;
    publish?: string;
    newversion?: string;
  };
}

export interface ZenodoError {
  message: string;
  status?: number;
  errors?: Array<{ field: string; message: string }>;
}

/**
 * Get the Zenodo API base URL
 */
function getApiUrl(sandbox: boolean): string {
  return sandbox ? ZENODO_SANDBOX_URL : ZENODO_API_URL;
}

/**
 * Create a new deposition (pre-reserve DOI)
 *
 * This creates a draft deposition with a pre-reserved DOI.
 * The DOI is not active until the deposition is published.
 */
export async function createDeposition(
  metadata: ZenodoMetadata,
  token: string,
  sandbox = false,
): Promise<ZenodoDeposition> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metadata: {
        upload_type: "dataset",
        title: metadata.title,
        description: metadata.description,
        creators: metadata.creators,
        keywords: metadata.keywords || ["BIDS", "neuroscience", "neuroimaging"],
        license: metadata.license || "cc-by-nc-4.0",
        access_right: "open",
        publication_date: metadata.publication_date || new Date().toISOString().split("T")[0],
        version: metadata.version,
        related_identifiers: metadata.related_identifiers,
      },
    }),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const error = (await response.json()) as ZenodoError;
      throw new Error(`Zenodo API error: ${error.message || response.statusText}`);
    } else {
      const text = await response.text();
      throw new Error(`Zenodo API error (${response.status}): ${text.substring(0, 200)}`);
    }
  }

  // Parse response body safely - Zenodo may return HTML even with JSON content-type
  const text = await response.text();
  try {
    return JSON.parse(text) as ZenodoDeposition;
  } catch {
    const contentType = response.headers.get("content-type");
    throw new Error(
      `Zenodo returned invalid JSON (status ${response.status}, content-type: ${contentType}): ${text.substring(0, 300)}`,
    );
  }
}

/**
 * Upload a file to a deposition
 *
 * The file is uploaded to the deposition's bucket.
 * Multiple files can be uploaded to the same deposition.
 */
export async function uploadFile(
  depositionId: number,
  bucketUrl: string,
  filename: string,
  fileContent: ArrayBuffer | Uint8Array,
  token: string,
  sandbox = false,
): Promise<{ checksum: string; filename: string; filesize: number }> {
  const response = await fetch(`${bucketUrl}/${filename}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/octet-stream",
    },
    body: fileContent,
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const error = (await response.json()) as ZenodoError;
      throw new Error(`Zenodo upload error: ${error.message || response.statusText}`);
    } else {
      const text = await response.text();
      throw new Error(`Zenodo upload error (${response.status}): ${text.substring(0, 200)}`);
    }
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Zenodo returned non-JSON response (${contentType}): ${text.substring(0, 200)}`);
  }

  return response.json() as Promise<{ checksum: string; filename: string; filesize: number }>;
}

/**
 * Publish a deposition
 *
 * WARNING: This makes the DOI PERMANENT. It cannot be deleted.
 * Only unpublished depositions can be published.
 */
export async function publishDeposition(
  depositionId: number,
  token: string,
  sandbox = false,
): Promise<ZenodoDeposition> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions/${depositionId}/actions/publish`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const error = (await response.json()) as ZenodoError;
      throw new Error(`Zenodo publish error: ${error.message || response.statusText}`);
    } else {
      const text = await response.text();
      throw new Error(`Zenodo publish error (${response.status}): ${text.substring(0, 200)}`);
    }
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Zenodo returned non-JSON response (${contentType}): ${text.substring(0, 200)}`);
  }

  return response.json() as Promise<ZenodoDeposition>;
}

/**
 * Get a deposition by ID
 */
export async function getDeposition(
  depositionId: number,
  token: string,
  sandbox = false,
): Promise<ZenodoDeposition> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions/${depositionId}`, {
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const error = (await response.json()) as ZenodoError;
      throw new Error(`Zenodo API error: ${error.message || response.statusText}`);
    } else {
      const text = await response.text();
      throw new Error(`Zenodo API error (${response.status}): ${text.substring(0, 200)}`);
    }
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Zenodo returned non-JSON response (${contentType}): ${text.substring(0, 200)}`);
  }

  return response.json() as Promise<ZenodoDeposition>;
}

/**
 * Create a new version of an existing published deposition
 *
 * This creates a new draft that is linked to the concept DOI.
 * The new version inherits metadata from the previous version.
 */
export async function createNewVersion(
  depositionId: number,
  token: string,
  sandbox = false,
): Promise<ZenodoDeposition> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions/${depositionId}/actions/newversion`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok) {
    const error = (await response.json()) as ZenodoError;
    throw new Error(`Zenodo new version error: ${error.message || response.statusText}`);
  }

  // The response contains the draft URL for the new version
  const result = (await response.json()) as ZenodoDeposition;

  // We need to get the actual new draft deposition
  // The 'links.latest_draft' contains the URL to the new draft
  if (result.links && "latest_draft" in result.links) {
    const draftResponse = await fetch((result.links as { latest_draft: string }).latest_draft, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (draftResponse.ok) {
      return draftResponse.json() as Promise<ZenodoDeposition>;
    }
  }

  return result;
}

/**
 * Update metadata on a draft deposition
 */
export async function updateDepositionMetadata(
  depositionId: number,
  metadata: Partial<ZenodoMetadata>,
  token: string,
  sandbox = false,
): Promise<ZenodoDeposition> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions/${depositionId}`, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      metadata: {
        upload_type: "dataset",
        ...metadata,
      },
    }),
  });

  if (!response.ok) {
    const contentType = response.headers.get("content-type");
    if (contentType?.includes("application/json")) {
      const error = (await response.json()) as ZenodoError;
      throw new Error(`Zenodo update error: ${error.message || response.statusText}`);
    } else {
      const text = await response.text();
      throw new Error(`Zenodo update error (${response.status}): ${text.substring(0, 200)}`);
    }
  }

  const contentType = response.headers.get("content-type");
  if (!contentType?.includes("application/json")) {
    const text = await response.text();
    throw new Error(`Zenodo returned non-JSON response (${contentType}): ${text.substring(0, 200)}`);
  }

  return response.json() as Promise<ZenodoDeposition>;
}

/**
 * Delete a draft deposition (only works for unpublished depositions)
 */
export async function deleteDeposition(
  depositionId: number,
  token: string,
  sandbox = false,
): Promise<void> {
  const apiUrl = getApiUrl(sandbox);

  const response = await fetch(`${apiUrl}/deposit/depositions/${depositionId}`, {
    method: "DELETE",
    headers: {
      Authorization: `Bearer ${token}`,
    },
  });

  if (!response.ok && response.status !== 204) {
    const error = (await response.json()) as ZenodoError;
    throw new Error(`Zenodo delete error: ${error.message || response.statusText}`);
  }
}

/**
 * Download a file from a URL (for GitHub releases)
 */
export async function downloadFile(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Download failed: ${response.statusText}`);
  }

  return response.arrayBuffer();
}

/**
 * Format a Zenodo DOI URL
 */
export function formatDoiUrl(doi: string): string {
  return `https://doi.org/${doi}`;
}

/**
 * Format a Zenodo record URL
 */
export function formatRecordUrl(depositionId: number, sandbox = false): string {
  const base = sandbox ? "https://sandbox.zenodo.org" : "https://zenodo.org";
  return `${base}/record/${depositionId}`;
}

/**
 * Extract the pre-reserved DOI from a deposition
 */
export function getPrereservedDoi(deposition: ZenodoDeposition): string | null {
  return deposition.metadata?.prereserve_doi?.doi || null;
}

/**
 * Check if a deposition is published
 */
export function isPublished(deposition: ZenodoDeposition): boolean {
  return deposition.submitted && deposition.state === "done";
}
