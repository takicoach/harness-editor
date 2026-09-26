/** HTTP failure codes are an open server response, not locally generated job
 * codes. Preserve unfamiliar codes and their message for the existing fallback UI. */
export function renderHttpError(body: Record<string, unknown>, status: number): {code: string; message: string} {
  const code = typeof body['error'] === 'string' ? body['error'] : 'unknown';
  return {
    code,
    message: typeof body['message'] === 'string' ? body['message'] : typeof body['error'] === 'string' ? body['error'] : `HTTP ${status}`,
  };
}
