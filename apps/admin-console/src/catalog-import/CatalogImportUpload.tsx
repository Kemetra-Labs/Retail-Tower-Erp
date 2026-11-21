/**
 * RT-1509: `/catalog/import`, step 1 of the product import workspace. A successful upload opens the
 * batch at `/catalog/import/:batchId` (the route carries the batch id, D2), where the workspace reads
 * it and shows the step its server state allows.
 */
import { useNavigate } from "react-router";
import { ImportFrame } from "./ImportFrame";
import { UploadStep } from "./UploadStep";

export function CatalogImportUpload(): React.JSX.Element {
  const navigate = useNavigate();
  return (
    <ImportFrame step="upload">
      <UploadStep onUploaded={(batch) => navigate(`/catalog/import/${batch.batchId}`)} />
    </ImportFrame>
  );
}
