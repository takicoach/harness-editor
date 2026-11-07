/** プロジェクトに保管する台本や書類（設計 2026-11-07）。形式は台本の読み込み（scriptImport の SCRIPT_FILE_ACCEPT）と同じ。 */
export const DOCUMENT_EXTENSIONS=['.docx','.pdf','.txt','.md','.markdown','.srt'] as const;
export const MAX_DOCUMENT_BYTES=50*1024*1024;
export const MAX_DOCUMENTS=50;
export const DOCUMENTS_FOLDER='資料';
/** path は 資料/ からの相対パス（区切りは常に /）。 */
export interface ProjectDocument {path:string;sizeBytes:number;absolutePath:string}
export const isDocumentName=(name:string):boolean=>{const lower=name.toLowerCase();return DOCUMENT_EXTENSIONS.some(ext=>lower.endsWith(ext));};
