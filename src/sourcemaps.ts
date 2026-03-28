export interface SourceMapUploadOptions {
  apiKey: string;
  ingestBaseUrl: string;
  release: string;
  files: Array<{ url: string; sourcemap: string; source?: string }>;
}

export async function uploadSourceMaps(options: SourceMapUploadOptions): Promise<{ uploaded: number; errors: string[] }> {
  const baseUrl = options.ingestBaseUrl.replace(/\/$/, "");
  const errors: string[] = [];
  let uploaded = 0;

  for (const file of options.files) {
    try {
      const res = await fetch(`${baseUrl}/ingest/sourcemaps`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          release: options.release,
          url: file.url,
          sourcemap: file.sourcemap,
          source: file.source,
        }),
      });
      if (res.ok) {
        uploaded++;
      } else {
        errors.push(`${file.url}: ${res.status} ${res.statusText}`);
      }
    } catch (err) {
      errors.push(`${file.url}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return { uploaded, errors };
}
