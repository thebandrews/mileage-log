import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/** Saves a report to the cache and opens the share sheet (Mail, Files, AirDrop…). */
export async function saveAndShare(res: Response, filename: string, mimeType: string): Promise<void> {
  const bytes = new Uint8Array(await res.arrayBuffer());
  const file = new File(Paths.cache, filename);
  file.create({ overwrite: true });
  await file.write(bytes);
  if (!(await Sharing.isAvailableAsync())) throw new Error('Sharing is not available on this device');
  await Sharing.shareAsync(file.uri, { mimeType, dialogTitle: filename, UTI: mimeType === 'application/pdf' ? 'com.adobe.pdf' : 'public.comma-separated-values-text' });
}
