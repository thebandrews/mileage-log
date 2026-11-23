/** Browser download via a temporary object URL. */
export async function saveAndShare(res: Response, filename: string, _mimeType: string): Promise<void> {
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
