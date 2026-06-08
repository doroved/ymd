/**
 * File download trigger from content script (MV3-safe)
 */

export function triggerDownload(blobUrl: string, filename: string): void {
  const a = document.createElement("a");
  a.href = blobUrl;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  // Revoke after a delay to ensure browser initiated download
  setTimeout(() => URL.revokeObjectURL(blobUrl), 30000);
}
