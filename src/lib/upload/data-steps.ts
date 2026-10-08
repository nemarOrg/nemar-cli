/**
 * Upload steps 9 to 11 as one unit: copy the data to the remote, write the NEMAR
 * metadata, save. They are one function so that what passes between them (the
 * annexed paths the copy listed, the remote the save must check against) is code that
 * can be run, rather than two lines in a command action nothing drives.
 */

import type { NemarMetadataPayload } from "../api/datasets.js";
import type { UploadProgress } from "../upload-progress.js";
import { saveDatasetStep, writeNemarMetadata } from "./finalize.js";
import {
  type OpenRemote,
  S3_REMOTE_NAME,
  type UploadFileEntry,
  uploadDataToS3,
} from "./transfer.js";
import { type DatasetInfo, FAIL, type Step, ok } from "./types.js";

export interface DataStepsArgs {
  absolutePath: string;
  options: { jobs: string };
  dataFiles: UploadFileEntry[];
  filesToUpload: Array<{ path: string; size: number; mtimeMs?: number }>;
  uploadProgress: UploadProgress | null;
  datasetInfo: DatasetInfo;
  coAuthorEnrichment: NemarMetadataPayload | undefined;
  author: { name: string; email: string } | undefined;
}

/**
 * Hooks for tests. `openRemote` replaces how the remote is opened, `skipMinBytes`
 * lets a small tree reach the large-tree branch of the save, and `saveStep` is the
 * save to call (defaulting to the real one) so a test can see what it was handed.
 */
export interface DataStepsDeps {
  openRemote?: OpenRemote;
  skipMinBytes?: number;
  saveStep?: typeof saveDatasetStep;
}

export async function runDataSteps(
  args: DataStepsArgs,
  deps: DataStepsDeps = {},
): Promise<Step<UploadProgress>> {
  // Step 9: Upload data files to S3 via the git-annex S3 special remote
  const uploaded = await uploadDataToS3(
    args.absolutePath,
    args.options,
    args.dataFiles,
    args.filesToUpload,
    args.uploadProgress,
    args.datasetInfo,
    { openRemote: deps.openRemote },
  );
  if (uploaded.status === "fail") return FAIL;
  const { progress, annexedPaths } = uploaded.value;

  // Step 10b: Ensure .nemar metadata is on disk and .bidsignore covers it
  writeNemarMetadata(args.absolutePath, args.coAuthorEnrichment, progress);

  // Step 11: Save dataset changes. The annexed set the copy listed spares the save a
  // walk of the tree, and the remote lets it fail on anything the save itself annexed.
  const save = deps.saveStep ?? saveDatasetStep;
  const saved = await save(args.absolutePath, args.author, progress, {
    annexedPaths,
    verifyRemote: S3_REMOTE_NAME,
    ...(deps.skipMinBytes === undefined ? {} : { skipMinBytes: deps.skipMinBytes }),
  });
  if (saved.status === "fail") return FAIL;
  return ok(progress);
}
